import http from "node:http";
import fsSync from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createDefaultRuntime } from "./abi-runtime.js";
import { resolveDataDir } from "./data-dir.js";
import { readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { createRequire } from "node:module";

const PACKAGE_VERSION = createRequire(import.meta.url)("../package.json").version;
import {
  buildSetCookie,
  checkAuth,
  checkOrigin,
  isPublicRoute,
  verifyTelegramSecret,
  verifyBuildBetterWebhook
} from "./auth.js";
import { ChannelManager } from "./channels.js";
import { inferToneScore } from "./outcome-store.js";
import { isFirstRun, renderWizard, saveEnv } from "./setup-wizard.js";
import { NodeRegistry, readOrCreateIdentity } from "./node-registry.js";
import { readNodeConfig } from "./cli-client.js";
import { redactKnownValues, sanitizeForAudit } from "./redact.js";
import { approvePendingAction } from "./pending-actions.js";
import { isModelProviderId } from "./model-router.js";
import {
  listProviderPresets,
  getProviderPreset,
  presetIsConfigured,
  presetActivationEnv,
  activeProviderPreset
} from "./provider-presets.js";
import { projectAllows, projectMemoryScope } from "./project-store.js";
import { resolveDailyLimit } from "./budget-guard.js";

const MAX_JOB_HTTP_BODY_BYTES = 256 * 1024;
const MAX_JOB_HTTP_LIST_LIMIT = 100;
const MAX_JOB_HTTP_WAIT_MS = 30_000;
const MAX_JOB_HTTP_RESULT_CHARS = 50_000;
const MAX_JOB_HTTP_RESULT_OFFSET = 64 * 1024 * 1024;
const HTTP_JOB_ID_RE = /^job_[a-f0-9]{16}$/;
const HTTP_JOB_SESSION_RE = /^[\x21-\x7E]{1,512}$/;
const HTTP_JOB_STATUSES = new Set([
  "queued",
  "running",
  "cancel_requested",
  "cancelled",
  "succeeded",
  "failed",
  "interrupted"
]);
const HTTP_JOB_KINDS = new Set(["tool", "direct-tool", "subagent"]);

function isHostedMoaProvider(provider) {
  const id = String(provider?.provider ?? provider?.name ?? "").trim().toLowerCase();
  return id === "moa" || provider?.constructor?.name === "MoaProvider";
}

// A request whose TCP peer is a loopback address is a process on this same
// box. The daemon binds 127.0.0.1 by default, so for the local dashboard
// this is always true — we use it to skip the sign-in wall for local
// operators while still gating paired remote nodes (non-loopback peers).
function isLoopbackPeer(req) {
  const addr = req?.socket?.remoteAddress ?? "";
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1" ||
    addr.startsWith("127.")
  );
}

function configuredMoaPresetNames(dataDir) {
  const config = readJsonFile(path.join(dataDir, "moa.json"), {});
  const root = config?.presets && typeof config.presets === "object"
    ? config.presets
    : config;
  if (!root || typeof root !== "object" || Array.isArray(root)) return [];
  return Object.entries(root)
    .filter(([name, preset]) => (
      /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,79}$/.test(name)
      && preset
      && typeof preset === "object"
      && !Array.isArray(preset)
      && preset.aggregator
    ))
    .map(([name]) => name)
    .sort();
}

export function createHostedInterface(runtime = createDefaultRuntime(), options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 43210;
  // Read these dynamically so the setup wizard can update them mid-flight.
  const getAuthToken = () => options.authToken ?? process.env.OPENAGI_AUTH_TOKEN ?? null;
  const getPublicUrl = () => options.publicUrl ?? process.env.OPENAGI_PUBLIC_URL ?? null;
  const getTelegramSecret = () => options.telegramSecret ?? process.env.TELEGRAM_WEBHOOK_SECRET ?? null;
  const createProvider = async (providerOptions = {}) => {
    if (typeof options.modelProviderFactory === "function") {
      return options.modelProviderFactory(providerOptions);
    }
    const { createModelProvider } = await import("./model-provider.js");
    return createModelProvider(providerOptions);
  };
  let channels =
    options.channels ??
    (runtime.agentHost
      ? new ChannelManager({
          agentHost: runtime.agentHost,
          runtime,
          dir: options.channelsDir,
          telegramToken: options.telegramToken
        })
      : null);

  // dataDir is resolved ONCE here and threaded explicitly into both
  // NodeRegistry's dir and the cache path below — NodeRegistry must NOT be
  // allowed to fall back to its own default (which calls resolveDataDir()
  // independently), because resolveDataDir() memoizes its first result for
  // the whole process; two hosted-interface instances in the same test
  // process (a main + a node) would otherwise silently collide on the same
  // directory the first one resolved.
  const dataDir = options.dataDir ?? resolveDataDir();
  const nodeRegistry = options.nodeRegistry ?? new NodeRegistry({ dir: options.nodesDir ?? path.join(dataDir, "nodes") });
  const nodesCachePath = path.join(dataDir, "nodes", "cache.json");
  const hostedSessionsRequireProjectStore =
    typeof runtime.projects?.projectForSession === "function";

  const events = runtime.events
    && typeof runtime.events.on === "function"
    && typeof runtime.events.emit === "function"
    ? runtime.events
    : new EventEmitter();
  events.setMaxListeners?.(50);

  const sseClients = new Set();
  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const eventProjectId = eventProject(data) ?? "default";
    for (const client of sseClients) {
      if (eventProjectId !== client.projectId) continue;
      try { client.res.write(payload); } catch { /* dropped */ }
    }
  }
  function broadcastProjectChange(data) {
    const payload = `event: project\ndata: ${JSON.stringify(data)}\n\n`;
    const changedProjectId = eventProject(data) ?? "default";
    for (const client of sseClients) {
      if (
        client.projectId !== "default"
        && client.projectId !== changedProjectId
      ) {
        continue;
      }
      try { client.res.write(payload); } catch { /* dropped */ }
    }
  }
  let previousProjectChange = null;
  let hostedProjectChange = null;
  if (runtime.projects) {
    previousProjectChange = runtime.projects.onChange;
    hostedProjectChange = (data) => {
      try { previousProjectChange?.(data); } finally { events.emit("project", data); }
    };
    runtime.projects.onChange = hostedProjectChange;
  }
  const ownedEventListeners = [];
  function bindHostedEvent(type, listener) {
    events.on(type, listener);
    ownedEventListeners.push({ type, listener });
  }
  bindHostedEvent("project", (data) => broadcastProjectChange(data));
  bindHostedEvent("message", (data) => broadcast("message", data));
  // Live agent activity from ANY channel (Discord, Telegram, cron, API).
  // Drives the pixel pet / holo avatar so the dashboard reflects what the
  // harness is actually doing, not just what the web composer submitted.
  bindHostedEvent("agent-activity", (data) => broadcast("agent-activity", data));
  bindHostedEvent("cron", (data) => broadcast("cron", data));
  bindHostedEvent("mcp", (data) => broadcast("mcp", data));
  bindHostedEvent("tunnel", (data) => broadcast("tunnel", data));
  bindHostedEvent("replay", (data) => broadcast("replay", data));
  bindHostedEvent("skill-candidate", (data) => broadcast("skill-candidate", data));
  bindHostedEvent(
    "skill-candidate-proposed",
    (data) => broadcast("skill-candidate-proposed", data)
  );
  bindHostedEvent("skill-use", (data) => broadcast("skill-use", data));
  bindHostedEvent("skill-edit", (data) => broadcast("skill-edit", data));
  bindHostedEvent("vision", (data) => broadcast("vision", data));
  bindHostedEvent("miner-result", (data) => broadcast("miner-result", data));
  bindHostedEvent("cron-catchup", (data) => broadcast("cron-catchup", data));
  bindHostedEvent("cron-job-timeout", (data) => broadcast("cron-job-timeout", data));
  bindHostedEvent("cron-interrupted", (data) => broadcast("cron-interrupted", data));
  bindHostedEvent("cron-model-mismatch", (data) => broadcast("cron-model-mismatch", data));
  bindHostedEvent("proactive-suggestion", (data) => broadcast("proactive-suggestion", data));
  bindHostedEvent("suggestion-resolved", (data) => broadcast("suggestion-resolved", data));
  bindHostedEvent("task-updated", (data) => broadcast("task-updated", data));
  bindHostedEvent("kanban-updated", (data) => broadcast("kanban-updated", data));
  bindHostedEvent("kanban-status", (data) => broadcast("kanban-status", data));
  bindHostedEvent("clarification-created", (data) => broadcast("clarification-created", data));
  bindHostedEvent("clarification-resolved", (data) => broadcast("clarification-resolved", data));
  bindHostedEvent("draft-created", (data) => broadcast("draft-created", data));
  bindHostedEvent("draft-resolved", (data) => broadcast("draft-resolved", data));
  for (const type of ["artifact-created", "artifact-updated", "artifact-restored"]) {
    bindHostedEvent(type, (data) => broadcast("artifact", {
      event: type,
      ...data
    }));
  }
  for (const type of [
    "recipe-proposed",
    "recipe-edited",
    "recipe-verified",
    "recipe-failed",
    "recipe-superseded",
    "recipe-deleted",
    "recipe-reindexed"
  ]) {
    bindHostedEvent(type, (data) => broadcast("recipe", {
      event: type,
      ...data
    }));
  }
  bindHostedEvent("session-branched", (data) => broadcast("session-branched", data));
  bindHostedEvent("task-reminder", (data) => broadcast("task-reminder", data));
  bindHostedEvent("task-auto-changed", (data) => broadcast("task-auto-changed", data));
  bindHostedEvent("pending-action", (data) => broadcast("pending-action", sanitizeForAudit(data)));
  bindHostedEvent("pending-action-decided", (data) => (
    broadcast("pending-action-decided", sanitizeForAudit(data))
  ));
  bindHostedEvent("daily-recap", (data) => broadcast("daily-recap", data));
  bindHostedEvent("daily-plan", (data) => broadcast("daily-plan", data));
  bindHostedEvent("task-unblocked", (data) => broadcast("task-unblocked", data));
  bindHostedEvent("job", (data) => {
    const status = jobSseStatusView(data);
    if (status) broadcast("job", status);
  });
  if (runtime.skillReplay) runtime.skillReplay.bindEvents(events);
  if (runtime.pendingActions?.bindEvents) runtime.pendingActions.bindEvents(events);
  if (runtime.computerUseLog?.bindEvents) runtime.computerUseLog.bindEvents(events);
  if (runtime.jobs?.bindEvents) runtime.jobs.bindEvents(events);
  bindHostedEvent("computer-use", (data) => broadcast("computer-use", data));
  bindHostedEvent("outreach", (data) => broadcast("outreach", data));
  bindHostedEvent("outreach-resolved", (data) => broadcast("outreach-resolved", data));
  bindHostedEvent("background-review", (data) => broadcast("background-review", data));
  bindHostedEvent("run-inspector", (data) => (
    broadcast("run-inspector", sanitizeForAudit(data))
  ));

  // Expose the bus to runtime subsystems (pattern miner, session miner) so
  // they can emit "skill-candidate" without holding a reference to this
  // module. Set non-enumerably so JSON serialization of runtime stays clean.
  if (!runtime.events) {
    Object.defineProperty(runtime, "events", { value: events, enumerable: false });
  }
  // Proactive outreach mapper subscribes here: it was constructed before the
  // bus existed, so we late-bind the same bus now (mirrors bindEvents above).
  if (runtime.bindOutreachEvents) runtime.bindOutreachEvents(runtime.events);
  // Discord activity feed: mirror observer suggestions / approvals / miner
  // results into the configured home channel (DISCORD_ACTIVITY_CHANNEL).
  if (channels?.discord?.bindActivityFeed) channels.discord.bindActivityFeed(events);

  // Mid-run boot note: if the previous process died while a cron job handler
  // was executing, the file-backed scheduler kept a { runningJobId, startedAt }
  // marker. Emit it now (the outreach mapper above is already attached, so it
  // lands as a durable feed item) and clear it. Optional-chained because the
  // in-memory CronScheduler has no marker support.
  const interruptedJob = runtime.cron?.consumeInterruption?.();
  if (interruptedJob) {
    events.emit("cron-interrupted", {
      at: new Date().toISOString(),
      jobId: interruptedJob.runningJobId,
      jobName: interruptedJob.jobName,
      startedAt: interruptedJob.startedAt,
      projectId: interruptedJob.projectId ?? "default",
      projectRevision: interruptedJob.projectRevision ?? null
    });
  }

  if (runtime.tunnelWatcher) {
    runtime.tunnelWatcher.on("tunnel-url", (data) => events.emit("tunnel", { op: "url", ...data }));
    runtime.tunnelWatcher.on("tunnel-changed", (data) => events.emit("tunnel", { op: "changed", ...data }));
    runtime.tunnelWatcher.start();
  }

  // Pending OAuth URLs per server, surfaced in the dashboard MCP tab.
  const pendingOauth = new Map();
  if (runtime.mcp) {
    runtime.mcp.onOauthRequired = ({ name, url }) => {
      pendingOauth.set(name, { url, at: new Date().toISOString() });
      events.emit("mcp", { op: "oauth-required", name, url });
    };
  }

  if (runtime.agentHost) {
    const original = runtime.agentHost.handleMessage.bind(runtime.agentHost);
    runtime.agentHost.handleMessage = async (input) => {
      try {
        const result = await original(input);
        events.emit("message", {
          sessionId: result.session.id,
          projectId: result.project?.id ?? result.session?.projectId ?? "default",
          agent: result.agent,
          reply: result.reply,
          toolCalls: result.output?.scrutiny?.action ? [] : []
        });
        // Terminal beat for the live-activity lane: lets the pet settle into
        // its happy "done" wave once a turn from any channel completes.
        try {
          events.emit("agent-activity", {
            projectId: result.project?.id ?? result.session?.projectId ?? "default",
            sessionId: result.session?.id ?? null,
            phase: "turn-end",
            ok: true
          });
        } catch { /* advisory */ }
        return result;
      } catch (err) {
        try {
          events.emit("agent-activity", { projectId: "default", phase: "turn-end", ok: false });
        } catch { /* advisory */ }
        throw err;
      }
    };
  }

  let tickerHandle = null;
  let heartbeatHandle = null;
  let gatewayStarted = false;
  const tickerMs = options.tickerMs ?? Number.parseInt(process.env.OPENAGI_TICKER_MS ?? "10000", 10);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? `${host}:${port}`}`);
      const pathname = url.pathname;
      const method = req.method;

      // Setup wizard. Available always (so you can re-run /setup to change keys),
      // but on first run it bypasses the auth gate since no token exists yet.
      const setupActive = isFirstRun();
      const setupRoutes = pathname === "/setup" || pathname === "/setup/save" || pathname === "/setup/test";
      const secretsRoute = pathname === "/secrets" || pathname.startsWith("/secrets/");
      const capabilityAdminRoute = (
        pathname === "/profiles"
        || pathname.startsWith("/profiles/")
        || pathname === "/capability-bundles"
        || pathname.startsWith("/capability-bundles/")
        || pathname === "/skill-imports"
        || pathname.startsWith("/skill-imports/")
      );
      // Project-scoped data surfaces added by the agent-workspace work. These
      // carry per-project artifacts, durable job control, and procedural
      // recipes, so they are authenticated rather than loopback-trusted —
      // otherwise any local process could read or drive another project.
      // Channel pairing is included: a pairing code is a bearer credential that
      // binds a new remote device, so it must never be mintable anonymously.
      const projectDataRoute = (
        pathname === "/artifacts"
        || pathname.startsWith("/artifacts/")
        || pathname === "/jobs"
        || pathname.startsWith("/jobs/")
        || pathname === "/recipes"
        || pathname.startsWith("/recipes/")
        // The run inspector serves project-scoped execution evidence: QA
        // screenshots, visual diffs, tool timelines, and stored artifacts.
        // That is project data, so it stays behind the auth gate even for a
        // loopback peer, exactly like /artifacts and /jobs.
        || pathname === "/runs"
        || pathname.startsWith("/runs/")
        || pathname.startsWith("/channels/telegram/pairing-code")
      );

      if (setupActive && method === "GET" && pathname === "/") {
        res.writeHead(302, { Location: "/setup" });
        return res.end();
      }

      // CSRF gate — block cross-origin browser POSTs against any state-changing
      // route (always on, even before auth is configured). Webhook routes
      // self-authenticate so we exempt them.
      if (!isPublicRoute(pathname)) {
        const origin = checkOrigin(req);
        if (!origin.ok) {
          res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ error: "forbidden", reason: origin.reason }));
        }
      }

      // Auth gate. Webhooks self-validate, /health stays open, setup routes
      // bypass auth ONLY during first-run (no token exists yet).
      const extraCookies = [];
      const setupBypass = setupActive && setupRoutes;
      // Loopback trust: the daemon binds 127.0.0.1 by default, so a request
      // arriving from a loopback peer is a local operator on this box — no
      // login wall for the dashboard. The bearer token still gates paired
      // REMOTE nodes (they connect over a non-loopback address), so the node
      // fabric and secrets API keep their protection. This is what removes
      // the sign-in page for the local Cerberus dashboard.
      const loopbackTrusted = isLoopbackPeer(req);
      // Loopback trust must NOT extend to the credential surfaces. Secrets and
      // capability administration stay authenticated even for a local peer:
      // any process on this box (or a browser coerced into a local request)
      // would otherwise read/write managed secrets and grant capabilities
      // anonymously. These two routes always fall through to the auth gate.
      const trustBypassAllowed = loopbackTrusted
        && !secretsRoute
        && !capabilityAdminRoute
        && !projectDataRoute;
      if (!isPublicRoute(pathname) && !setupBypass && !trustBypassAllowed) {
        const authToken = getAuthToken();
        // The rest of the local-only API retains its backwards-compatible
        // auth-disabled mode. The secrets surface is different: it must never
        // become anonymously reachable because OPENAGI_AUTH_TOKEN is absent.
        const auth = (secretsRoute || capabilityAdminRoute) && !authToken
          ? {
              ok: false,
              reason: secretsRoute
                ? "OPENAGI_AUTH_TOKEN is required for the secrets API"
                : "OPENAGI_AUTH_TOKEN is required for capability administration"
            }
          : checkAuth(req, url, authToken);
        if (!auth.ok) {
          // Browsers (Accept: text/html) get the login form on ANY failed GET,
          // not just GET /. After sign-in, redirect back to the original path.
          const accept = req.headers.accept ?? "";
          const wantsHtml = method === "GET" && accept.includes("text/html");
          if (wantsHtml && getAuthToken()) {
            const next = pathname + url.search;
            return sendHtml(res, 401, renderLoginPage(auth.reason ?? "auth required", next));
          }
          res.writeHead(401, {
            "content-type": "application/json; charset=utf-8",
            "WWW-Authenticate": "Bearer"
          });
          return res.end(JSON.stringify({ error: "unauthorized", reason: auth.reason ?? "auth required" }));
        }
        if (auth.setCookie) extraCookies.push(buildSetCookie(getAuthToken()));
      }

      // Sign-in: server-side cookie set, then redirect. Works without JS.
      // Public route — the token in the body IS the credential.
      if (method === "POST" && pathname === "/sign-in") {
        const form = await readForm(req);
        const expected = getAuthToken();
        const token = form.token ?? "";
        const next = (form.next && form.next.startsWith("/") && !form.next.startsWith("//")) ? form.next : "/";
        if (!expected || token !== expected) {
          return sendHtml(res, 401, renderLoginPage("invalid token", next));
        }
        res.writeHead(302, {
          Location: next,
          "Set-Cookie": buildSetCookie(expected)
        });
        return res.end();
      }

      // Setup wizard handlers — work both during first-run (auth-bypassed)
      // and after-auth (so users can re-edit env from the dashboard's Settings).
      if (method === "GET" && pathname === "/setup") {
        requireDefaultRequestProject(
          runtime,
          req,
          url,
          null,
          "Setup administration"
        );
        // Re-runs prefill from the live env: the existing auth token is
        // KEPT (a re-run used to silently rotate it on save), provider/
        // model/budget show their current values, and already-set secrets
        // get a "saved" marker instead of looking unconfigured.
        return sendHtml(res, 200, renderWizard({ existingEnv: process.env }), extraCookies);
      }
      if (method === "POST" && pathname === "/setup/save") {
        const body = await readJson(req);
        requireDefaultRequestProject(
          runtime,
          req,
          url,
          body,
          "Setup administration"
        );
        let result;
        try {
          result = saveEnv({
            dataDir,
            values: body,
            store: runtime.secrets,
            decidedBy: "http:/setup/save"
          });
        } catch {
          return sendSecretsJson(res, 500, { error: "setup persistence failed" });
        }
        try {
          if (runtime.agentHost) {
            runtime.agentHost.modelProvider = await createProvider({
              budgetGuard: runtime.budget,
              secrets: runtime.secrets,
              dataDir: runtime.secrets?.dataDir
            });
          }
        } catch { /* swallow */ }
        if (process.env.OPENAGI_AUTH_TOKEN) {
          res.setHeader("Set-Cookie", buildSetCookie(process.env.OPENAGI_AUTH_TOKEN));
        }
        return sendSecretsJson(res, 200, result);
      }
      if (method === "POST" && pathname === "/setup/test") {
        const body = await readJson(req);
        requireDefaultRequestProject(
          runtime,
          req,
          url,
          body,
          "Setup administration"
        );
        if (!channels) return sendSecretsJson(res, 503, { error: "agent-host-disabled" });
        try {
          // ephemeral: the connectivity test must not seed a session, task,
          // memory item, or outcome — it's plumbing, not conversation.
          const turn = await channels.handleLocalMessage({ text: body.text ?? "Say hi in one short sentence.", from: "setup", ephemeral: true });
          let safeTurn = { reply: turn.reply, model: turn.model };
          if (runtime.secrets) {
            const names = runtime.secrets.listSecretNames({
              decidedBy: "http:/setup/test:list"
            });
            const values = runtime.secrets.exportEnv({
              names,
              decidedBy: "http:/setup/test:redact"
            });
            safeTurn = redactKnownValues(safeTurn, Object.values(values));
          }
          return sendSecretsJson(res, 200, safeTurn);
        } catch {
          return sendSecretsJson(res, 500, { error: "setup connectivity test failed" });
        }
      }

      if (method === "GET" && pathname === "/secrets") {
        if (!runtime.secrets?.listSecrets) {
          return sendSecretsJson(res, 503, { error: "secrets-unavailable" });
        }
        try {
          const project = requireRequestProject(runtime, req, url);
          const secrets = runtime.secrets
            .listSecrets({ decidedBy: "http:GET:/secrets" })
            .filter((entry) => projectAllows(
              project.secretRefs,
              entry.name ?? entry.key
            ))
            .map((entry) => publicSecretMetadata(entry));
          return sendSecretsJson(res, 200, { secrets });
        } catch (error) {
          if (error?.code === "PROJECT_BOUNDARY_VIOLATION") throw error;
          return sendSecretsJson(res, 500, { error: "secrets-unavailable" });
        }
      }
      if (method === "POST" && pathname === "/secrets") {
        if (!runtime.secrets?.setSecret) {
          return sendSecretsJson(res, 503, { error: "secrets-unavailable" });
        }
        const body = await readJson(req).catch(() => null);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return sendSecretsJson(res, 400, { error: "valid JSON object required" });
        }
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name || typeof body.value !== "string" || !body.value.trim()) {
          return sendSecretsJson(res, 400, { error: "name and non-blank string value are required" });
        }
        try {
          const project = requireRequestProject(runtime, req, url, body);
          if (project.id !== "default") {
            return sendSecretsJson(
              res,
              403,
              { error: "Secret updates are default-project only" }
            );
          }
          if (!projectAllows(project.secretRefs, name)) {
            return sendSecretsJson(res, 403, { error: "secret is outside the current project" });
          }
          const stored = runtime.secrets.setSecret(name, body.value, {
            decidedBy: "http:POST:/secrets"
          });
          return sendSecretsJson(res, 200, { secret: publicSecretMetadata(stored, name) });
        } catch (error) {
          return sendSecretsJson(res, 400, { error: publicSecretError(error) });
        }
      }
      if (method === "DELETE" && pathname.match(/^\/secrets\/[^/]+$/)) {
        if (!runtime.secrets?.removeSecret) {
          return sendSecretsJson(res, 503, { error: "secrets-unavailable" });
        }
        const name = decodeURIComponent(pathname.slice("/secrets/".length)).trim();
        const project = requireRequestProject(runtime, req, url);
        if (!projectAllows(project.secretRefs, name)) {
          return sendSecretsJson(res, 403, { error: "secret is outside the current project" });
        }
        if (project.id !== "default") {
          return sendSecretsJson(
            res,
            403,
            { error: "Secret deletion is default-project only" }
          );
        }
        // Removing the live auth token would make checkAuth enter its legacy
        // auth-disabled mode for every other route in this running process.
        // Rotation via POST remains available; remote deletion does not.
        if (name === "OPENAGI_AUTH_TOKEN") {
          return sendSecretsJson(res, 409, {
            error: "OPENAGI_AUTH_TOKEN cannot be removed through the secrets API; rotate it with POST /secrets"
          });
        }
        try {
          const removed = runtime.secrets.removeSecret(name, {
            decidedBy: "http:DELETE:/secrets"
          });
          return sendSecretsJson(res, 200, { name, removed: Boolean(removed) });
        } catch (error) {
          return sendSecretsJson(res, 400, { error: publicSecretError(error) });
        }
      }

      if (method === "GET" && pathname === "/" && extraCookies.length) {
        // Strip ?token from URL after we set the cookie.
        const clean = url.pathname;
        res.writeHead(302, { Location: clean, "Set-Cookie": extraCookies });
        return res.end();
      }

      if (method === "GET" && pathname === "/") return sendHtml(res, 200, renderApp(), extraCookies);
      // firstRun lets clients (Mac app) know setup has never completed, so
      // they can take the user to the wizard instead of sitting silent.
      if (method === "GET" && pathname === "/health") {
        // Public liveness only — {ok, firstRun}. The full runtime status
        // (cron records + inputs, channel state, etc.) used to be public
        // here; it now requires auth (Tier-1 hardening, 2026-07).
        // /health is a PUBLIC route, so it never passes through the
        // loopback-trust branch above and no auth cookie is minted for a local
        // operator. Without honouring loopbackTrusted here the local dashboard's
        // refreshHealth() reads an undefined `status`, throws, and pins the
        // header pill to OFFLINE while the daemon is plainly up. This payload is
        // read-only status (no credentials, no project data), so extending
        // loopback trust to it grants nothing the local operator lacks.
        const authed = loopbackTrusted || checkAuth(req, url, getAuthToken()).ok;
        if (!authed) {
          return sendJson(res, 200, { ok: true, firstRun: isFirstRun() });
        }
        const project = requireRequestProject(runtime, req, url);
        return sendJson(
          res,
          200,
          project.id === "default"
            ? { ok: true, firstRun: isFirstRun(), status: runtime.status() }
            : {
                ok: true,
                firstRun: isFirstRun(),
                status: {
                  agentHost: runtime.agentHost
                    ? {
                        provider: project.modelProfile?.provider
                          ?? runtime.agentHost.modelProvider?.constructor?.name
                          ?? null,
                        providerConfigured:
                          runtime.agentHost.modelProvider?.isConfigured?.() ?? false
                      }
                    : null,
                  project: {
                    id: project.id,
                    status: project.status,
                    revision: project.revision
                  }
                }
              }
        );
      }
      if (method === "GET" && pathname === "/projects") {
        const requestProject = requireRequestProject(runtime, req, url);
        const projects = runtime.projects?.list?.({
          includeArchived: url.searchParams.get("archived") === "1"
        }) ?? [];
        return sendJson(res, 200, {
          projects: requestProject.id === "default"
            ? projects
            : projects.filter((project) => project.id === requestProject.id)
        });
      }
      if (method === "POST" && pathname === "/projects") {
        const body = await readJson(req);
        try {
          requireDefaultRequestProject(
            runtime,
            req,
            url,
            body,
            "Project creation"
          );
          const project = runtime.projects.create(body, {
            actor: "http:POST:/projects"
          });
          return sendJson(res, 201, project);
        } catch (error) {
          if (error?.code === "PROJECT_BOUNDARY_VIOLATION") throw error;
          return sendJson(res, 400, { error: error.message, code: error.code ?? null });
        }
      }
      if (pathname.match(/^\/projects\/[^/]+$/)) {
        const id = decodeURIComponent(pathname.split("/")[2]);
        if (method === "GET") {
          const requestProject = requireRequestProject(runtime, req, url);
          if (requestProject.id !== "default" && requestProject.id !== id) {
            return sendJson(res, 404, { error: "unknown project" });
          }
          const project = runtime.projects?.get?.(id);
          return project
            ? sendJson(res, 200, project)
            : sendJson(res, 404, { error: "unknown project" });
        }
        if (method === "PATCH") {
          const body = await readJson(req);
          try {
            requireDefaultRequestProject(
              runtime,
              req,
              url,
              body,
              "Project updates"
            );
            const project = runtime.projects.update(id, body.patch ?? body, {
              expectedRevision: body.expectedRevision,
              actor: "http:PATCH:/projects"
            });
            return sendJson(res, 200, project);
          } catch (error) {
            if (error?.code === "PROJECT_BOUNDARY_VIOLATION") throw error;
            return sendJson(
              res,
              error.code === "PROJECT_REVISION_CONFLICT" ? 409 : 400,
              { error: error.message, code: error.code ?? null }
            );
          }
        }
      }
      if (method === "POST" && pathname.match(/^\/projects\/[^/]+\/select$/)) {
        const id = decodeURIComponent(pathname.split("/")[2]);
        const requestProject = requireRequestProject(runtime, req, url);
        if (requestProject.id !== "default" && requestProject.id !== id) {
          return sendJson(res, 404, { error: "unknown or archived project" });
        }
        const project = runtime.projects?.get?.(id, { includeArchived: false });
        return project
          ? sendJson(res, 200, {
              project,
              selection: "client-local",
              message: "Send X-OpenAGI-Project on project-scoped requests."
            })
          : sendJson(res, 404, { error: "unknown or archived project" });
      }
      if (method === "POST" && pathname.match(/^\/projects\/[^/]+\/archive$/)) {
        const id = decodeURIComponent(pathname.split("/")[2]);
        const body = await readJson(req).catch(() => ({}));
        try {
          requireDefaultRequestProject(
            runtime,
            req,
            url,
            body,
            "Project archival"
          );
          const project = runtime.projects.archive(id, {
            expectedRevision: body.expectedRevision,
            actor: "http:POST:/projects/archive"
          });
          return sendJson(res, 200, project);
        } catch (error) {
          if (error?.code === "PROJECT_BOUNDARY_VIOLATION") throw error;
          return sendJson(
            res,
            error.code === "PROJECT_REVISION_CONFLICT" ? 409 : 400,
            { error: error.message, code: error.code ?? null }
          );
        }
      }

      // Named profiles, project-scoped capability grants, and inert skill
      // import quarantine. These administration routes require a configured
      // auth token even when the rest of the legacy local API is auth-less.
      if (method === "GET" && pathname === "/profiles/audit") {
        if (!runtime.profiles?.history) {
          return sendJson(res, 503, { error: "capability profiles unavailable" });
        }
        const project = requireRequestProject(runtime, req, url);
        try {
          return sendJson(res, 200, {
            events: runtime.profiles.history({
              projectId: project.id,
              limit: url.searchParams.has("limit")
                ? Number(url.searchParams.get("limit"))
                : 100
            })
          });
        } catch (error) {
          return sendCapabilityHttpError(res, error);
        }
      }
      if (method === "POST" && pathname === "/profiles/activate") {
        if (!runtime.profiles?.bindProjectProfile) {
          return sendJson(res, 503, { error: "capability profiles unavailable" });
        }
        const body = await readJson(req).catch(() => null);
        const project = requireRequestProject(runtime, req, url, body);
        try {
          const profileId = body?.id == null || body.id === ""
            ? null
            : body.id;
          if (!Object.hasOwn(body ?? {}, "expectedBindingProfileId")) {
            throw new TypeError("expectedBindingProfileId is required.");
          }
          if (
            profileId
            && (
              !Number.isSafeInteger(body?.expectedProfileRevision)
              || body.expectedProfileRevision < 1
            )
          ) {
            throw new TypeError(
              "expectedProfileRevision is required when activating a profile."
            );
          }
          const bindingContext = {
            expectedBindingProfileId: body.expectedBindingProfileId,
            expectedProfileRevision: body.expectedProfileRevision,
            actor: "http:POST:/profiles/activate"
          };
          const resolution = body?.scope === "project"
            ? runtime.profiles.bindProjectProfile(
                project.id,
                profileId,
                bindingContext
              )
            : body?.scope === "session"
              ? runtime.profiles.bindSessionProfile(
                  project.id,
                  body?.sessionId,
                  profileId,
                  bindingContext
                )
              : (() => {
                  throw new TypeError("scope must be project or session.");
                })();
          events.emit("capability-profile", {
            op: profileId ? "activate" : "clear",
            projectId: project.id,
            profileId,
            scope: body.scope,
            sessionId: body.scope === "session" ? body.sessionId : null
          });
          return sendJson(res, 200, resolution);
        } catch (error) {
          return sendCapabilityHttpError(res, error);
        }
      }
      if (method === "GET" && pathname === "/profiles") {
        if (!runtime.profiles?.listProfiles) {
          return sendJson(res, 503, { error: "capability profiles unavailable" });
        }
        const project = requireRequestProject(runtime, req, url);
        try {
          return sendJson(res, 200, {
            profiles: runtime.profiles.listProfiles({
              projectId: project.id,
              includeRevoked: url.searchParams.get("revoked") === "1"
            }),
            active: runtime.profiles.resolve(
              project.id,
              url.searchParams.get("sessionId") || null
            )
          });
        } catch (error) {
          return sendCapabilityHttpError(res, error);
        }
      }
      if (method === "POST" && pathname === "/profiles") {
        if (!runtime.profiles?.createProfile) {
          return sendJson(res, 503, { error: "capability profiles unavailable" });
        }
        const body = await readJson(req).catch(() => null);
        const project = requireRequestProject(runtime, req, url, body);
        try {
          const profile = runtime.profiles.createProfile(
            project.id,
            body ?? {},
            { actor: "http:POST:/profiles" }
          );
          events.emit("capability-profile", {
            op: "create",
            projectId: project.id,
            profileId: profile.id,
            revision: profile.revision
          });
          return sendJson(res, 201, profile);
        } catch (error) {
          return sendCapabilityHttpError(res, error);
        }
      }
      if (method === "GET" && /^\/profiles\/[^/]+$/u.test(pathname)) {
        if (!runtime.profiles?.getProfile) {
          return sendJson(res, 503, { error: "capability profiles unavailable" });
        }
        const project = requireRequestProject(runtime, req, url);
        const id = decodeURIComponent(pathname.slice("/profiles/".length));
        try {
          const profile = runtime.profiles.getProfile(project.id, id, {
            includeRevoked: true
          });
          return profile
            ? sendJson(res, 200, profile)
            : sendJson(res, 404, { error: "unknown profile" });
        } catch (error) {
          return sendCapabilityHttpError(res, error);
        }
      }
      if (method === "PATCH" && /^\/profiles\/[^/]+$/u.test(pathname)) {
        if (!runtime.profiles?.updateProfile) {
          return sendJson(res, 503, { error: "capability profiles unavailable" });
        }
        const body = await readJson(req).catch(() => null);
        const project = requireRequestProject(runtime, req, url, body);
        const id = decodeURIComponent(pathname.slice("/profiles/".length));
        try {
          const profile = runtime.profiles.updateProfile(
            project.id,
            id,
            body ?? {},
            { actor: "http:PATCH:/profiles" }
          );
          events.emit("capability-profile", {
            op: "update",
            projectId: project.id,
            profileId: profile.id,
            revision: profile.revision
          });
          return sendJson(res, 200, profile);
        } catch (error) {
          return sendCapabilityHttpError(res, error);
        }
      }
      if (method === "POST" && /^\/profiles\/[^/]+\/revoke$/u.test(pathname)) {
        if (!runtime.profiles?.revokeProfile) {
          return sendJson(res, 503, { error: "capability profiles unavailable" });
        }
        const body = await readJson(req).catch(() => null);
        const project = requireRequestProject(runtime, req, url, body);
        const id = decodeURIComponent(
          pathname.slice("/profiles/".length, -"/revoke".length)
        );
        try {
          const profile = runtime.profiles.revokeProfile(project.id, id, {
            expectedRevision: body?.expectedRevision,
            actor: "http:POST:/profiles/revoke"
          });
          events.emit("capability-profile", {
            op: "revoke",
            projectId: project.id,
            profileId: profile.id,
            revision: profile.revision
          });
          return sendJson(res, 200, profile);
        } catch (error) {
          return sendCapabilityHttpError(res, error);
        }
      }

      if (method === "GET" && pathname === "/capability-bundles") {
        if (!runtime.profiles?.listBundles) {
          return sendJson(res, 503, { error: "capability profiles unavailable" });
        }
        const project = requireRequestProject(runtime, req, url);
        try {
          return sendJson(res, 200, {
            bundles: runtime.profiles.listBundles({
              projectId: project.id,
              includeRevoked: url.searchParams.get("revoked") === "1"
            })
          });
        } catch (error) {
          return sendCapabilityHttpError(res, error);
        }
      }
      if (method === "POST" && pathname === "/capability-bundles") {
        if (!runtime.profiles?.createBundle) {
          return sendJson(res, 503, { error: "capability profiles unavailable" });
        }
        const body = await readJson(req).catch(() => null);
        const project = requireRequestProject(runtime, req, url, body);
        try {
          const bundle = runtime.profiles.createBundle(
            project.id,
            body ?? {},
            { actor: "http:POST:/capability-bundles" }
          );
          events.emit("capability-bundle", {
            op: "create",
            projectId: project.id,
            bundleId: bundle.id,
            revision: bundle.revision,
            status: bundle.status
          });
          return sendJson(res, 201, bundle);
        } catch (error) {
          return sendCapabilityHttpError(res, error);
        }
      }
      if (method === "GET" && /^\/capability-bundles\/[^/]+$/u.test(pathname)) {
        if (!runtime.profiles?.getBundle) {
          return sendJson(res, 503, { error: "capability profiles unavailable" });
        }
        const project = requireRequestProject(runtime, req, url);
        const id = decodeURIComponent(
          pathname.slice("/capability-bundles/".length)
        );
        try {
          const bundle = runtime.profiles.getBundle(project.id, id, {
            includeRevoked: true
          });
          return bundle
            ? sendJson(res, 200, bundle)
            : sendJson(res, 404, { error: "unknown capability bundle" });
        } catch (error) {
          return sendCapabilityHttpError(res, error);
        }
      }
      if (method === "PATCH" && /^\/capability-bundles\/[^/]+$/u.test(pathname)) {
        if (!runtime.profiles?.updateBundle) {
          return sendJson(res, 503, { error: "capability profiles unavailable" });
        }
        const body = await readJson(req).catch(() => null);
        const project = requireRequestProject(runtime, req, url, body);
        const id = decodeURIComponent(
          pathname.slice("/capability-bundles/".length)
        );
        try {
          const bundle = runtime.profiles.updateBundle(
            project.id,
            id,
            body ?? {},
            { actor: "http:PATCH:/capability-bundles" }
          );
          events.emit("capability-bundle", {
            op: "update",
            projectId: project.id,
            bundleId: bundle.id,
            revision: bundle.revision,
            status: bundle.status
          });
          return sendJson(res, 200, bundle);
        } catch (error) {
          return sendCapabilityHttpError(res, error);
        }
      }
      if (
        method === "POST"
        && /^\/capability-bundles\/[^/]+\/enable$/u.test(pathname)
      ) {
        if (!runtime.profiles?.setBundleEnabled) {
          return sendJson(res, 503, { error: "capability profiles unavailable" });
        }
        const body = await readJson(req).catch(() => null);
        const project = requireRequestProject(runtime, req, url, body);
        const id = decodeURIComponent(
          pathname.slice(
            "/capability-bundles/".length,
            -"/enable".length
          )
        );
        try {
          const bundle = runtime.profiles.setBundleEnabled(
            project.id,
            id,
            body?.enabled,
            {
              expectedRevision: body?.expectedRevision,
              actor: "http:POST:/capability-bundles/enable"
            }
          );
          events.emit("capability-bundle", {
            op: body?.enabled ? "enable" : "disable",
            projectId: project.id,
            bundleId: bundle.id,
            revision: bundle.revision,
            status: bundle.status
          });
          return sendJson(res, 200, bundle);
        } catch (error) {
          return sendCapabilityHttpError(res, error);
        }
      }
      if (
        method === "POST"
        && /^\/capability-bundles\/[^/]+\/revoke$/u.test(pathname)
      ) {
        if (!runtime.profiles?.revokeBundle) {
          return sendJson(res, 503, { error: "capability profiles unavailable" });
        }
        const body = await readJson(req).catch(() => null);
        const project = requireRequestProject(runtime, req, url, body);
        const id = decodeURIComponent(
          pathname.slice(
            "/capability-bundles/".length,
            -"/revoke".length
          )
        );
        try {
          const bundle = runtime.profiles.revokeBundle(project.id, id, {
            expectedRevision: body?.expectedRevision,
            actor: "http:POST:/capability-bundles/revoke"
          });
          events.emit("capability-bundle", {
            op: "revoke",
            projectId: project.id,
            bundleId: bundle.id,
            revision: bundle.revision,
            status: bundle.status
          });
          return sendJson(res, 200, bundle);
        } catch (error) {
          return sendCapabilityHttpError(res, error);
        }
      }

      if (method === "GET" && pathname === "/skill-imports") {
        if (!runtime.skillImports?.list) {
          return sendJson(res, 503, { error: "skill import quarantine unavailable" });
        }
        const project = requireRequestProject(runtime, req, url);
        try {
          return sendJson(res, 200, {
            imports: runtime.skillImports.list({
              projectId: project.id,
              status: url.searchParams.get("status") || null,
              includeResolved: url.searchParams.get("resolved") !== "0"
            })
          });
        } catch (error) {
          return sendCapabilityHttpError(res, error);
        }
      }
      if (method === "POST" && pathname === "/skill-imports") {
        if (!runtime.skillImports?.stage) {
          return sendJson(res, 503, { error: "skill import quarantine unavailable" });
        }
        const body = await readJson(req).catch(() => null);
        const project = requireRequestProject(runtime, req, url, body);
        try {
          const candidate = runtime.skillImports.stage({
            ...(body ?? {}),
            projectId: project.id
          }, {
            actor: "http:POST:/skill-imports"
          });
          events.emit("skill-import", {
            op: "stage",
            projectId: project.id,
            candidateId: candidate.id,
            revision: candidate.revision,
            status: candidate.status,
            skillName: candidate.skillName
          });
          return sendJson(res, 201, candidate);
        } catch (error) {
          return sendCapabilityHttpError(res, error);
        }
      }
      if (method === "GET" && /^\/skill-imports\/[^/]+$/u.test(pathname)) {
        if (!runtime.skillImports?.review) {
          return sendJson(res, 503, { error: "skill import quarantine unavailable" });
        }
        const project = requireRequestProject(runtime, req, url);
        const id = decodeURIComponent(pathname.slice("/skill-imports/".length));
        try {
          return sendJson(res, 200, runtime.skillImports.review(id, {
            projectId: project.id,
            file: url.searchParams.get("file")
          }));
        } catch (error) {
          return sendCapabilityHttpError(res, error);
        }
      }
      if (
        method === "POST"
        && /^\/skill-imports\/[^/]+\/approve$/u.test(pathname)
      ) {
        if (!runtime.skillImports?.approve) {
          return sendJson(res, 503, { error: "skill import quarantine unavailable" });
        }
        const body = await readJson(req).catch(() => null);
        const project = requireRequestProject(runtime, req, url, body);
        const id = decodeURIComponent(
          pathname.slice("/skill-imports/".length, -"/approve".length)
        );
        try {
          const candidate = runtime.skillImports.approve(id, {
            projectId: project.id,
            expectedRevision: body?.expectedRevision
          }, {
            actor: "http:POST:/skill-imports/approve"
          });
          events.emit("skill-import", {
            op: "approve",
            projectId: project.id,
            candidateId: candidate.id,
            revision: candidate.revision,
            status: candidate.status,
            skillName: candidate.skillName
          });
          return sendJson(res, 200, candidate);
        } catch (error) {
          return sendCapabilityHttpError(res, error);
        }
      }
      if (
        method === "POST"
        && /^\/skill-imports\/[^/]+\/reject$/u.test(pathname)
      ) {
        if (!runtime.skillImports?.reject) {
          return sendJson(res, 503, { error: "skill import quarantine unavailable" });
        }
        const body = await readJson(req).catch(() => null);
        const project = requireRequestProject(runtime, req, url, body);
        const id = decodeURIComponent(
          pathname.slice("/skill-imports/".length, -"/reject".length)
        );
        try {
          const candidate = runtime.skillImports.reject(id, {
            projectId: project.id,
            expectedRevision: body?.expectedRevision,
            reason: body?.reason
          }, {
            actor: "http:POST:/skill-imports/reject"
          });
          events.emit("skill-import", {
            op: "reject",
            projectId: project.id,
            candidateId: candidate.id,
            revision: candidate.revision,
            status: candidate.status,
            skillName: candidate.skillName
          });
          return sendJson(res, 200, candidate);
        } catch (error) {
          return sendCapabilityHttpError(res, error);
        }
      }

      if (method === "GET" && pathname === "/memory") {
        const project = requireRequestProject(runtime, req, url);
        return sendJson(res, 200, projectMemorySnapshot(runtime.memory, project));
      }
      if (method === "POST" && pathname === "/memory/remember") {
        // Direct memory import (auth-gated) — for migrations from another
        // agent, bulk seeding, or integrations. Body: { content, tags?,
        // importance?, scope?, source?, replaceIds? }. Mirrors `remember`.
        const body = await readJson(req);
        const project = requireRequestProject(runtime, req, url, body);
        const content = String(body?.content ?? "").trim();
        if (!content) return sendJson(res, 400, { error: "content required" });
        if (body.replaceIds !== undefined && !Array.isArray(body.replaceIds)) {
          return sendJson(res, 400, { error: "replaceIds must be an array of active curated-memory ids" });
        }
        const replaceIds = Array.isArray(body.replaceIds) ? body.replaceIds : [];
        if (replaceIds.length > 20
          || replaceIds.some((id) => typeof id !== "string" || !id.trim())
          || new Set(replaceIds.map((id) => id.trim())).size !== replaceIds.length) {
          return sendJson(res, 400, {
            error: "replaceIds must contain at most 20 unique, non-empty string ids"
          });
        }
        const importance = body.importance ?? "normal";
        try {
          const item = runtime.memory.remember(
            {
              source: body.source ?? "import",
              scope: projectMemoryScope(project),
              content,
              tags: ["import", ...(Array.isArray(body.tags) ? body.tags : [])],
              risk: importance === "high" ? 0.8 : importance === "low" ? 0.2 : 0.45,
              specificity: 0.7,
              repetition: 0.4,
              novelty: 0.5,
              metadata: { projectId: project.id }
            },
            {
              source: "memory-import",
              strength: importance === "high" ? 0.85 : 0.6,
              capacityManaged: true,
              replaceIds: replaceIds.map((id) => id.trim())
            }
          );
          return sendJson(res, 200, {
            id: item.id,
            tier: item.tier,
            replaced: item.metadata?.replaces ?? []
          });
        } catch (error) {
          if (error?.code === "MEMORY_CAPACITY_EXCEEDED") {
            return sendJson(res, 409, {
              error: error.message,
              code: error.code,
              usedChars: error.usedChars,
              requestedChars: error.requestedChars,
              maxChars: error.maxChars
            });
          }
          if (/^Cannot replace curated memory /u.test(String(error?.message ?? ""))) {
            return sendJson(res, 409, { error: error.message, code: "MEMORY_REPLACEMENT_CONFLICT" });
          }
          throw error;
        }
      }
      if (method === "GET" && pathname === "/agents") {
        requireDefaultRequestProject(runtime, req, url, null, "Agent administration");
        return sendJson(
          res,
          200,
          runtime.agentHost?.store.listAgents() ?? runtime.propagation.list()
        );
      }
      if (method === "GET" && pathname === "/specialists") {
        requireDefaultRequestProject(
          runtime,
          req,
          url,
          null,
          "Specialist administration"
        );
        const includeRetired = url.searchParams.get("retired") === "1";
        return sendJson(res, 200, runtime.propagation.list({ includeRetired }));
      }
      if (method === "POST" && pathname.match(/^\/specialists\/[^/]+\/retire$/)) {
        requireDefaultRequestProject(
          runtime,
          req,
          url,
          null,
          "Specialist administration"
        );
        const id = decodeURIComponent(pathname.split("/")[2]);
        const sp = runtime.propagation.retire(id, "manual");
        if (!sp) return sendJson(res, 404, { error: "unknown-specialist" });
        return sendJson(res, 200, sp);
      }
      if (method === "GET" && pathname === "/sessions") {
        const project = requireRequestProject(runtime, req, url);
        assertHostedProjectStoreAvailable(
          runtime,
          hostedSessionsRequireProjectStore
        );
        const sessionStore = runtime.agentHost?.store;
        const sessions = (sessionStore?.listSessions() ?? [])
          .filter((session) => {
            try {
              assertHostedSessionProject(
                runtime,
                sessionStore,
                session.id,
                project,
                { projectStoreRequired: hostedSessionsRequireProjectStore }
              );
              return true;
            } catch {
              return false;
            }
          });
        return sendJson(res, 200, sessions);
      }
      if (method === "POST" && pathname === "/sessions/reset") {
        if (typeof runtime.agentHost?.resetSession !== "function") {
          return sendJson(res, 503, { error: "agent-host-disabled" });
        }
        const body = await readJson(req);
        if (!body?.sessionId) return sendJson(res, 400, { error: "sessionId required" });
        const project = requireRequestProject(runtime, req, url, body);
        try {
          assertHostedSessionProject(
            runtime,
            runtime.agentHost?.store,
            body.sessionId,
            project,
            { projectStoreRequired: hostedSessionsRequireProjectStore }
          );
        } catch (error) {
          return sendJson(res, 404, { error: error.message });
        }
        return sendJson(res, 200, runtime.agentHost.resetSession({
          sessionId: body.sessionId,
          channel: body.channel,
          from: body.from,
          agentId: body.agentId,
          projectId: project.id,
          projectRevision: project.revision,
          projectHookIds: project.hookIds
        }));
      }
      if (method === "POST" && /^\/sessions\/[^/]+\/branches$/u.test(pathname)) {
        if (typeof runtime.agentHost?.branchSession !== "function") {
          return sendJson(res, 503, { error: "session branching unavailable" });
        }
        const sourceSessionId = decodeURIComponent(
          pathname.slice("/sessions/".length, -"/branches".length)
        );
        const body = await readJson(req).catch(() => null);
        if (
          !body
          || typeof body !== "object"
          || Array.isArray(body)
          || Object.keys(body).length !== 1
          || typeof body.messageId !== "string"
          || !body.messageId.trim()
        ) {
          return sendJson(res, 400, { error: "messageId is required" });
        }
        const project = requireRequestProject(runtime, req, url);
        try {
          assertHostedSessionProject(
            runtime,
            runtime.agentHost.store,
            sourceSessionId,
            project,
            { projectStoreRequired: hostedSessionsRequireProjectStore }
          );
          const branch = await runtime.agentHost.branchSession({
            sourceSessionId,
            messageId: body.messageId,
            projectId: project.id,
            agentId: "main"
          });
          return sendJson(res, 201, branch);
        } catch (error) {
          if (error?.code === "SESSION_BRANCH_TARGET_EXISTS") {
            return sendJson(res, 409, { error: "session branch conflict" });
          }
          if (error?.code === "SESSION_BRANCH_MESSAGE_AMBIGUOUS") {
            return sendJson(res, 409, { error: "ambiguous branch message" });
          }
          if (
            error?.code === "SESSION_NOT_FOUND"
            || error?.code === "SESSION_BRANCH_MESSAGE_NOT_FOUND"
            || error?.code === "PROJECT_BOUNDARY_VIOLATION"
          ) {
            return sendJson(res, 404, { error: "unknown session or message" });
          }
          if (error instanceof TypeError || error instanceof RangeError) {
            return sendJson(res, 400, { error: error.message });
          }
          throw error;
        }
      }
      if (method === "GET" && pathname.startsWith("/sessions/")) {
        const project = requireRequestProject(runtime, req, url);
        const id = decodeURIComponent(pathname.slice("/sessions/".length));
        try {
          assertHostedSessionProject(
            runtime,
            runtime.agentHost?.store,
            id,
            project,
            { projectStoreRequired: hostedSessionsRequireProjectStore }
          );
        } catch {
          return sendJson(res, 404, { error: "unknown session" });
        }
        return sendJson(res, 200, runtime.agentHost?.store.getSession(id) ?? { error: "agent-host-disabled" });
      }
      if (method === "GET" && pathname === "/agent-host") {
        requireDefaultRequestProject(runtime, req, url, null, "Agent host status");
        return sendJson(res, 200, runtime.agentHost?.status() ?? { enabled: false });
      }
      if (method === "POST" && pathname === "/nodes/heartbeat") {
        const body = await readJson(req).catch(() => ({}));
        requireDefaultRequestProject(
          runtime,
          req,
          url,
          body,
          "Node administration"
        );
        // Type-checked, not just truthy: a non-string name/nodeId previously
        // persisted and crashed NodeRegistry.list()'s name.localeCompare sort
        // with a TypeError, taking down GET /nodes with a 500 until the
        // poisoned entry aged out. role is restricted to exactly "node" —
        // only this instance's own self-entry may ever claim role "main";
        // nothing arriving over the wire should be able to.
        if (typeof body.nodeId !== "string" || !body.nodeId || typeof body.name !== "string" || !body.name) {
          return sendJson(res, 400, { error: "nodeId and name are required and must be non-empty strings" });
        }
        if (body.role !== "node") {
          return sendJson(res, 400, { error: 'role must be "node"' });
        }
        if (body.url !== undefined && body.url !== null && typeof body.url !== "string") {
          return sendJson(res, 400, { error: "url must be a string or null" });
        }
        if (body.version !== undefined && body.version !== null && typeof body.version !== "string") {
          return sendJson(res, 400, { error: "version must be a string or null" });
        }
        nodeRegistry.upsert({
          nodeId: body.nodeId, name: body.name, role: body.role,
          url: body.url ?? null, version: body.version ?? null
        });
        return sendJson(res, 200, { ok: true });
      }
      if (method === "GET" && pathname === "/nodes") {
        requireDefaultRequestProject(runtime, req, url, null, "Node administration");
        const identity = readOrCreateIdentity(dataDir);
        const pairing = readNodeConfig(dataDir);
        if (!pairing?.remote) {
          return sendJson(res, 200, {
            self: { nodeId: identity.nodeId, name: identity.name, role: "main", version: PACKAGE_VERSION, pairedTo: null },
            nodes: nodeRegistry.list(),
            stale: false,
            cachedAt: null
          });
        }
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 5000);
          let upstream;
          try {
            upstream = await fetch(`${pairing.remote}/nodes`, {
              headers: pairing.token ? { authorization: `Bearer ${pairing.token}` } : {},
              signal: ctrl.signal
            });
          } finally { clearTimeout(timer); }
          if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
          const upstreamJson = redactKnownValues(
            await upstream.json(),
            pairing.token ? [pairing.token] : []
          );
          const cached = { ...upstreamJson, cachedAt: new Date().toISOString() };
          // Best-effort only: a fresh roster we already have in hand must
          // still be returned even if persisting it to disk fails (e.g. a
          // full disk, or a stale nodes/cache.json path that isn't a
          // directory) — caching is an optimization for the next request,
          // not a precondition for answering this one.
          try { writeJsonAtomic(nodesCachePath, cached); } catch { /* best-effort */ }
          return sendJson(res, 200, {
            self: { nodeId: identity.nodeId, name: identity.name, role: "node", version: PACKAGE_VERSION, pairedTo: pairing.remote },
            nodes: cached.nodes ?? [],
            stale: false,
            cachedAt: cached.cachedAt
          });
        } catch {
          const cached = redactKnownValues(
            readJsonFile(nodesCachePath, null),
            pairing.token ? [pairing.token] : []
          );
          if (cached) {
            try { writeJsonAtomic(nodesCachePath, cached); } catch { /* best effort */ }
          }
          return sendJson(res, 200, {
            self: { nodeId: identity.nodeId, name: identity.name, role: "node", version: PACKAGE_VERSION, pairedTo: pairing.remote },
            nodes: cached?.nodes ?? [],
            stale: true,
            cachedAt: cached?.cachedAt ?? null
          });
        }
      }
      if (method === "GET" && pathname === "/channels") {
        requireDefaultRequestProject(runtime, req, url, null, "Channel administration");
        const status = channels?.status() ?? { enabled: false };
        const pub = getPublicUrl();
        const base = pub ? pub.replace(/\/$/, "") : null;
        const bbSecret = options.buildBetterWebhookSecret ?? process.env.BUILDBETTER_WEBHOOK_SECRET ?? null;
        return sendJson(res, 200, {
          ...status,
          publicUrl: pub,
          // Return the endpoint, never the credential-bearing query string.
          // BuildBetter can send the saved value via its webhook-secret
          // header, or the user can append it locally in BuildBetter's UI.
          buildBetterWebhook: base ? `${base}/webhooks/buildbetter` : null,
          buildBetterWebhookReady: Boolean(base && bbSecret)
        });
      }
      if (method === "GET" && pathname === "/channels/telegram/pairing-code") {
        requireDefaultRequestProject(runtime, req, url, null, "Channel administration");
        // Auth-gated like every non-public route (isPublicRoute does not list
        // it, so the global checkAuth gate above already ran). Issues a fresh
        // one-time code and prints it to the daemon log too, so a headless
        // install can pair straight from daemon.log/journald.
        if (!channels?.telegram?.pairing) return sendJson(res, 503, { error: "agent-host-disabled" });
        const issued = channels.telegram.pairing.generateCode();
        console.log(`[openagi] telegram pairing code ${issued.code} (valid 10 min, single use) — send "/pair ${issued.code}" to the bot`);
        return sendJson(res, 200, issued);
      }
      if (method === "GET" && pathname === "/tools") {
        const project = requireRequestProject(runtime, req, url);
        const tools = runtime.tools.list().filter((tool) => (
          projectAllows(project.policy?.allowedTools, tool.name)
          && (
            tool.source !== "mcp"
            || projectAllows(project.mcpGrants, tool.metadata?.server)
          )
          && (
            tool.source !== "skill"
            || tool.metadata?.skill === undefined
            || projectAllows(project.activeSkills, tool.metadata.skill)
          )
        ));
        return sendJson(res, 200, tools);
      }

      if (method === "GET" && pathname === "/events") {
        const project = requireRequestProject(runtime, req, url);
        return handleSse(req, res, sseClients, project.id);
      }

      if (method === "GET" && pathname === "/runs") {
        const project = requireRequestProject(runtime, req, url);
        res.setHeader("Cache-Control", "no-store");
        if (!runtime.runInspector?.list) {
          return sendJson(res, 503, { error: "run inspector unavailable" });
        }
        try {
          const runs = runtime.runInspector.list({
            projectId: project.id,
            kind: url.searchParams.get("kind") || null,
            status: url.searchParams.get("status") || null,
            limit: Number(url.searchParams.get("limit") ?? 100)
          });
          return sendJson(res, 200, sanitizeForAudit({ runs }));
        } catch (error) {
          return sendJson(res, 400, {
            error: String(error?.message ?? "invalid run query").slice(0, 500)
          });
        }
      }

      const runArtifactRoute = /^\/runs\/qa\/([^/]+)\/artifacts\/([^/]+)$/u
        .exec(pathname);
      if (method === "GET" && runArtifactRoute) {
        const project = requireRequestProject(runtime, req, url);
        if (!runtime.runInspector?.readQaArtifact) {
          return sendJson(res, 503, { error: "run inspector unavailable" });
        }
        try {
          const artifact = runtime.runInspector.readQaArtifact({
            projectId: project.id,
            runId: decodeURIComponent(runArtifactRoute[1]),
            ref: decodeURIComponent(runArtifactRoute[2])
          });
          if (!artifact) {
            return sendJson(res, 404, { error: "run artifact not found" });
          }
          return sendRunArtifact(res, artifact);
        } catch (error) {
          return sendJson(res, 404, {
            error: String(error?.message ?? "run artifact not found").slice(0, 500)
          });
        }
      }

      const runDetailRoute = /^\/runs\/(turn|coder|qa|job)\/([^/]+)$/u
        .exec(pathname);
      if (method === "GET" && runDetailRoute) {
        const project = requireRequestProject(runtime, req, url);
        res.setHeader("Cache-Control", "no-store");
        if (!runtime.runInspector?.detail) {
          return sendJson(res, 503, { error: "run inspector unavailable" });
        }
        try {
          const run = runtime.runInspector.detail({
            projectId: project.id,
            kind: runDetailRoute[1],
            runId: decodeURIComponent(runDetailRoute[2])
          });
          return run
            ? sendJson(res, 200, sanitizeForAudit({ run }))
            : sendJson(res, 404, { error: "run not found" });
        } catch (error) {
          return sendJson(res, 400, {
            error: String(error?.message ?? "invalid run id").slice(0, 500)
          });
        }
      }

      if (method === "POST" && pathname === "/jobs") {
        if (!runtime.jobs?.start) {
          return sendJson(res, 503, { error: "durable jobs are unavailable" });
        }
        let body;
        try {
          body = await readJson(req);
          assertPlainHttpJobBody(body);
          if (jsonUtf8Bytes(body) > MAX_JOB_HTTP_BODY_BYTES) {
            return sendJson(res, 413, {
              error: `job request exceeds ${MAX_JOB_HTTP_BODY_BYTES} bytes`
            });
          }
        } catch (error) {
          return sendJson(res, 400, {
            error: safeJobHttpMessage(error, "invalid job request")
          });
        }
        const project = requireRequestProject(runtime, req, url, body);
        let sessionId;
        try {
          sessionId = normalizeHttpJobSession(body.sessionId);
          assertHttpJobSessionProject(runtime.projects, project, sessionId);
        } catch (error) {
          return sendJson(res, 400, {
            error: safeJobHttpMessage(error, "invalid job session")
          });
        }
        const input = { ...body };
        delete input.projectId;
        delete input.sessionId;
        try {
          const job = await runtime.jobs.start(
            input,
            jobHttpContext(project, sessionId)
          );
          const view = jobHttpStatusView(job, project.id);
          if (!view) throw new Error("job start returned no status");
          if (runtime.jobs.emitsEvents !== true) {
            events.emit("job", {
              op: "start",
              projectId: project.id,
              job: view
            });
          }
          return sendJson(res, 202, view);
        } catch (error) {
          return sendJobHttpError(res, error);
        }
      }

      if (method === "GET" && pathname === "/jobs") {
        if (!runtime.jobs?.list) {
          return sendJson(res, 503, { error: "durable jobs are unavailable" });
        }
        const project = requireRequestProject(runtime, req, url);
        try {
          const filters = httpJobListFilters(url.searchParams);
          const jobs = await runtime.jobs.list(
            filters,
            jobHttpContext(project)
          );
          const views = (Array.isArray(jobs) ? jobs : [])
            .map((job) => jobHttpStatusView(job, project.id))
            .filter(Boolean)
            .slice(0, filters.limit);
          return sendJson(res, 200, {
            count: views.length,
            jobs: views
          });
        } catch (error) {
          return sendJobHttpError(res, error);
        }
      }

      const jobRoute = /^\/jobs\/([^/]+)(?:\/(wait|result|cancel))?$/.exec(pathname);
      if (jobRoute) {
        if (!runtime.jobs) {
          return sendJson(res, 503, { error: "durable jobs are unavailable" });
        }
        const project = requireRequestProject(runtime, req, url);
        let jobId;
        try {
          jobId = normalizeHttpJobId(decodeURIComponent(jobRoute[1]));
        } catch {
          return sendJson(res, 400, { error: "invalid job id" });
        }
        const action = jobRoute[2] ?? "status";
        const context = jobHttpContext(project);

        if (method === "GET" && action === "status") {
          if (!runtime.jobs.status) {
            return sendJson(res, 503, { error: "job status is unavailable" });
          }
          try {
            const job = await runtime.jobs.status(jobId, context);
            const view = jobHttpStatusView(job, project.id);
            return view
              ? sendJson(res, 200, view)
              : sendJson(res, 404, { error: "unknown job" });
          } catch (error) {
            return sendJobHttpError(res, error);
          }
        }

        if (method === "GET" && action === "wait") {
          if (!runtime.jobs.wait) {
            return sendJson(res, 503, { error: "job wait is unavailable" });
          }
          let timeoutMs;
          try {
            timeoutMs = boundedHttpJobInteger(url.searchParams.get("timeoutMs"), {
              fallback: MAX_JOB_HTTP_WAIT_MS,
              min: 1,
              max: MAX_JOB_HTTP_WAIT_MS,
              field: "timeoutMs"
            });
          } catch (error) {
            return sendJson(res, 400, {
              error: safeJobHttpMessage(error, "invalid wait timeout")
            });
          }
          try {
            const job = await runtime.jobs.wait(
              jobId,
              { timeoutMs },
              context
            );
            const timedOut = job?.timedOut === true;
            const view = jobHttpStatusView(job, project.id);
            return view
              ? sendJson(res, 200, { timedOut, job: view })
              : sendJson(res, 404, { error: "unknown job" });
          } catch (error) {
            if (error?.code === "JOB_WAIT_TIMEOUT" && runtime.jobs.status) {
              try {
                const current = await runtime.jobs.status(jobId, context);
                const view = jobHttpStatusView(current, project.id);
                return view
                  ? sendJson(res, 200, { timedOut: true, job: view })
                  : sendJson(res, 404, { error: "unknown job" });
              } catch (statusError) {
                return sendJobHttpError(res, statusError);
              }
            }
            return sendJobHttpError(res, error);
          }
        }

        if (method === "GET" && action === "result") {
          if (!runtime.jobs.collect) {
            return sendJson(res, 503, { error: "job collection is unavailable" });
          }
          let offset;
          let maxChars;
          try {
            offset = boundedHttpJobInteger(url.searchParams.get("offset"), {
              fallback: 0,
              min: 0,
              max: MAX_JOB_HTTP_RESULT_OFFSET,
              field: "offset"
            });
            maxChars = boundedHttpJobInteger(url.searchParams.get("maxChars"), {
              fallback: 12_000,
              min: 1,
              max: MAX_JOB_HTTP_RESULT_CHARS,
              field: "maxChars"
            });
          } catch (error) {
            return sendJson(res, 400, {
              error: safeJobHttpMessage(error, "invalid result range")
            });
          }
          try {
            const collected = await runtime.jobs.collect(
              jobId,
              { offset, maxChars },
              context
            );
            if (!collected) return sendJson(res, 404, { error: "unknown job" });
            return sendJson(
              res,
              200,
              boundedHttpJobCollection(collected, project.id, maxChars)
            );
          } catch (error) {
            return sendJobHttpError(res, error);
          }
        }

        if (method === "POST" && action === "cancel") {
          if (!runtime.jobs.cancel) {
            return sendJson(res, 503, { error: "job cancellation is unavailable" });
          }
          try {
            const job = await runtime.jobs.cancel(jobId, context);
            const view = jobHttpStatusView(job, project.id);
            if (!view) return sendJson(res, 404, { error: "unknown job" });
            if (runtime.jobs.emitsEvents !== true) {
              events.emit("job", {
                op: "cancel",
                projectId: project.id,
                job: view
              });
            }
            return sendJson(res, 200, view);
          } catch (error) {
            return sendJobHttpError(res, error);
          }
        }
      }

      if (method === "POST" && pathname === "/ingest") {
        const body = await readJson(req);
        requireDefaultRequestProject(
          runtime,
          req,
          url,
          body,
          "Integration event ingestion"
        );
        const outputs = runtime.processIntegrationEvent(body.source ?? "abi", body.payload ?? body);
        return sendJson(res, 200, { outputs });
      }

      if (method === "POST" && pathname === "/message") {
        if (!channels) return sendJson(res, 503, { error: "agent-host-disabled" });
        const body = await readJson(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return sendJson(res, 400, { error: "valid JSON object required" });
        }
        // `ephemeral` (no session/memory/task) is an INTERNAL flag for the
        // setup-test path only — never let a public /message caller set it to
        // evade persistence.
        delete body.ephemeral;
        const project = requireRequestProject(runtime, req, url, body);
        body.projectId = project.id;
        body.metadata = {
          ...(body.metadata ?? {}),
          projectId: project.id
        };
        // Chat must return a structured error, not a generic 500: the
        // dashboard needs to distinguish "budget cap hit" / "provider auth
        // failed" / "network blip" to show something actionable.
        try {
          const result = await channels.handleLocalMessage(body);
          return sendJson(res, 200, result);
        } catch (error) {
          const code = error?.code === "BUDGET_EXCEEDED" || /budget/i.test(error?.message ?? "") ? "budget" : "agent-error";
          return sendJson(res, 500, { error: error.message ?? String(error), code });
        }
      }

      if (method === "POST" && pathname === "/channels/telegram/webhook") {
        if (!channels) return sendJson(res, 503, { error: "agent-host-disabled" });
        const tg = verifyTelegramSecret({
          headerValue: req.headers["x-telegram-bot-api-secret-token"],
          expected: getTelegramSecret()
        });
        if (!tg.ok) return sendJson(res, 401, { error: "unauthorized", reason: tg.reason });
        const body = await readJson(req);
        const result = await channels.handleTelegramWebhook(body);
        return sendJson(res, 200, result);
      }

      if (method === "POST" && pathname === "/webhooks/buildbetter") {
        // Near-real-time push: BuildBetter pings here when a call finishes /
        // an extraction lands, and we trigger a sync immediately instead of
        // waiting for the 15-min poll. Fails closed without a configured
        // secret. The payload itself is advisory — we re-pull via the API
        // (which dedupes), so a spoofed body can't inject tasks.
        const expected = options.buildBetterWebhookSecret ?? process.env.BUILDBETTER_WEBHOOK_SECRET ?? null;
        const bb = verifyBuildBetterWebhook({
          headerValue: req.headers["x-buildbetter-webhook-secret"],
          queryValue: url.searchParams.get("secret"),
          expected
        });
        if (!bb.ok) return sendJson(res, 401, { error: "unauthorized", reason: bb.reason });
        await readJson(req).catch(() => ({})); // drain body; we don't trust it for ingestion
        const source = runtime.buildBetterTaskSource;
        // The source is always registered (so a mid-session MCP login works
        // without restart), so also check it's actually configured — otherwise
        // a sync would no-op. Returning 503 (not a false 202) lets BuildBetter
        // retry the delivery once credentials land.
        if (!source?.triggerSync || !source.isConfigured?.()) {
          return sendJson(res, 503, { error: "buildbetter source not configured" });
        }
        // Don't block the webhook response on the full sync — ack fast,
        // sync in the background (BuildBetter expects a quick 200).
        source.triggerSync().then(
          (r) => runtime.events?.emit?.("integration-sync", { source: "buildbetter", trigger: "webhook", ...r }),
          (err) => runtime.events?.emit?.("integration-sync", { source: "buildbetter", trigger: "webhook", error: err?.message })
        );
        return sendJson(res, 202, { accepted: true });
      }

      if (method === "GET" && pathname === "/budget") {
        requireDefaultRequestProject(runtime, req, url, null, "Budget administration");
        return sendJson(res, 200, runtime.budget?.status?.() ?? { error: "no-budget" });
      }
      if (method === "POST" && pathname === "/budget/limit") {
        const body = await readJson(req).catch(() => ({}));
        requireDefaultRequestProject(runtime, req, url, body, "Budget administration");
        if (!runtime.budget) {
          return sendJson(res, 503, { error: "no-budget" });
        }
        let resolved;
        try {
          resolved = resolveDailyLimit(
            Object.hasOwn(body, "limit") ? body.limit : null
          );
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
        const persisted = resolved === null ? "off" : String(resolved);
        try {
          saveEnv({
            dataDir,
            values: { OPENAGI_DAILY_USD_LIMIT: persisted },
            store: runtime.secrets,
            decidedBy: "http:/budget/limit"
          });
        } catch {
          return sendJson(res, 500, { error: "configuration persistence failed" });
        }
        if (typeof runtime.budget.setDailyLimit === "function") {
          runtime.budget.setDailyLimit(persisted);
        } else {
          runtime.budget.dailyUsdLimit = resolved;
        }
        const status = runtime.budget.status?.() ?? {
          enabled: resolved !== null,
          dailyUsdLimit: resolved
        };
        events.emit("budget-limit", status);
        return sendJson(res, 200, status);
      }
      if (method === "GET" && pathname === "/budget/ledger") {
        requireDefaultRequestProject(runtime, req, url, null, "Budget administration");
        const ledger = runtime.budget?.ledger;
        if (!ledger) return sendJson(res, 200, { error: "no-ledger" });
        // Cap at the ledger's retention window so the reported `days` always
        // matches the data actually returned (query/analytics clamp the same way).
        const maxDays = ledger.retentionDays ?? 30;
        const requested = Math.max(1, Number.parseInt(url.searchParams.get("days") ?? "30", 10) || 30);
        const days = Math.min(maxDays, requested);
        return sendJson(res, 200, { days, requestedDays: requested, retentionDays: maxDays, entries: ledger.query({ days }), analytics: ledger.analytics({ days }) });
      }

      // ─── Ambient capture / observations ─────────────────────────────────
      if (method === "POST" && pathname === "/observations") {
        const body = await readJson(req);
        requireDefaultRequestProject(
          runtime,
          req,
          url,
          body,
          "Ambient observation administration"
        );
        const observations = Array.isArray(body) ? body : (Array.isArray(body.observations) ? body.observations : [body]);
        const sourceMachineId = (!Array.isArray(body) && typeof body.sourceMachineId === "string" && body.sourceMachineId) ? body.sourceMachineId : null;
        try {
          const result = await runtime.observations.record(observations, { sourceMachineId });
          return sendJson(res, 200, result);
        } catch (error) {
          return sendJson(res, 500, { error: error.message });
        }
      }
      if (method === "GET" && pathname === "/observations/search") {
        requireDefaultRequestProject(
          runtime,
          req,
          url,
          null,
          "Ambient observation access"
        );
        const query = url.searchParams.get("q") ?? null;
        const since = url.searchParams.get("since") ?? null;
        const until = url.searchParams.get("until") ?? null;
        const app = url.searchParams.get("app") ?? null;
        const machine = url.searchParams.get("machine") ?? null;
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "25", 10);
        const results = await runtime.observations.search({ query, since, until, app, machine, limit });
        return sendJson(res, 200, results);
      }
      if (method === "GET" && pathname === "/observations/timeline") {
        requireDefaultRequestProject(
          runtime,
          req,
          url,
          null,
          "Ambient observation access"
        );
        const since = url.searchParams.get("since") ?? null;
        return sendJson(res, 200, await runtime.observations.timelineByHour({ since }));
      }
      if (method === "GET" && pathname === "/observations/stats") {
        requireDefaultRequestProject(
          runtime,
          req,
          url,
          null,
          "Ambient observation access"
        );
        return sendJson(res, 200, await runtime.observations.stats());
      }
      if (method === "POST" && pathname === "/observations/prune") {
        const body = await readJson(req).catch(() => ({}));
        requireDefaultRequestProject(
          runtime,
          req,
          url,
          body,
          "Ambient observation administration"
        );
        return sendJson(res, 200, await runtime.observations.prune(body));
      }

      if (method === "GET" && pathname === "/admin/provider") {
        requireDefaultRequestProject(runtime, req, url, null, "Provider administration");
        const provider = runtime.agentHost?.modelProvider;
        const moaPresets = configuredMoaPresetNames(dataDir);
        return sendJson(res, 200, {
          current: provider?.constructor?.name ?? null,
          model: provider?.model ?? null,
          configured: provider?.isConfigured?.() ?? false,
          preference: process.env.OPENAGI_PROVIDER ?? "auto",
          moaPreset: process.env.OPENAGI_MOA_PRESET ?? null,
          moaPresets,
          available: {
            anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
            openai: Boolean(process.env.OPENAI_API_KEY),
            moa: moaPresets.length > 0
          }
        });
      }
      if (method === "POST" && pathname === "/admin/provider") {
        const body = await readJson(req);
        requireDefaultRequestProject(
          runtime,
          req,
          url,
          body,
          "Provider administration"
        );
        const choice = String(body.preference ?? "").toLowerCase();
        if (!isModelProviderId(choice, { includeAuto: true })) {
          return sendJson(res, 400, { error: "preference must be one of: auto, anthropic, openai, moa" });
        }
        const requestedPreset = String(
          body.preset ?? process.env.OPENAGI_MOA_PRESET ?? ""
        ).trim();
        if (choice === "moa" && requestedPreset && !/^[\w.\-:/]{2,80}$/.test(requestedPreset)) {
          return sendJson(res, 400, { error: "invalid MoA preset" });
        }
        let nextProvider = runtime.agentHost?.modelProvider ?? null;
        try {
          nextProvider = await createProvider({
            preferred: choice,
            moa: { preset: requestedPreset || undefined },
            budgetGuard: runtime.budget,
            secrets: runtime.secrets,
            dataDir: runtime.secrets?.dataDir
          });
          if (choice === "moa" && !isHostedMoaProvider(nextProvider)) {
            return sendJson(res, 400, {
              error: `MoA preset not found: ${requestedPreset || "(default)"}`
            });
          }
        } catch (error) {
          return sendJson(res, 400, { error: error?.message ?? String(error) });
        }
        process.env.OPENAGI_PROVIDER = choice;
        if (choice === "moa" && requestedPreset) {
          process.env.OPENAGI_MOA_PRESET = requestedPreset;
        }
        if (runtime.agentHost) runtime.agentHost.modelProvider = nextProvider;
        // Also persist to .env so it survives restart.
        try {
          const { saveEnv } = await import("./setup-wizard.js");
          const values = { OPENAGI_PROVIDER: choice };
          if (choice === "moa" && requestedPreset) {
            values.OPENAGI_MOA_PRESET = requestedPreset;
          }
          saveEnv({
            dataDir,
            values,
            store: runtime.secrets,
            decidedBy: "http:/admin/provider"
          });
        } catch { /* fall back to runtime-only */ }
        return sendJson(res, 200, {
          preference: choice,
          current: runtime.agentHost?.modelProvider?.constructor?.name ?? null,
          model: runtime.agentHost?.modelProvider?.model ?? null,
          moaPreset: choice === "moa"
            ? (runtime.agentHost?.modelProvider?.model ?? requestedPreset ?? null)
            : null
        });
      }
      if (method === "GET" && pathname === "/audit") {
        requireDefaultRequestProject(runtime, req, url, null, "Runtime audit access");
        return sendJson(res, 200, runtime.introspector?.audit?.() ?? null);
      }

      if (method === "GET" && pathname === "/scrutiny/weights") {
        requireDefaultRequestProject(runtime, req, url, null, "Scrutiny administration");
        const weights = {};
        if (runtime.scrutiny?.judges) {
          for (const [name, judge] of Object.entries(runtime.scrutiny.judges)) {
            weights[name] = { weights: judge.weights, thresholds: judge.thresholds };
          }
        } else if (runtime.scrutiny?.weights) {
          weights.single = { weights: runtime.scrutiny.weights, thresholds: runtime.scrutiny.thresholds };
        }
        return sendJson(res, 200, { weights, fitter: runtime.scrutinyFitter?.status?.() ?? null });
      }
      if (method === "GET" && pathname === "/scrutiny/pending") {
        requireDefaultRequestProject(runtime, req, url, null, "Scrutiny administration");
        return sendJson(res, 200, runtime.scrutinyFitter?.pending ?? null);
      }
      if (method === "POST" && pathname.match(/^\/scrutiny\/pending\/\d+\/apply$/)) {
        requireDefaultRequestProject(runtime, req, url, null, "Scrutiny administration");
        const cycle = Number.parseInt(pathname.split("/")[3], 10);
        const result = runtime.scrutinyFitter?.applyPending(cycle);
        if (!result) return sendJson(res, 404, { error: "no pending proposal for cycle" });
        return sendJson(res, 200, result);
      }
      if (method === "POST" && pathname === "/scrutiny/fit") {
        requireDefaultRequestProject(runtime, req, url, null, "Scrutiny administration");
        return sendJson(res, 200, runtime.scrutinyFitter?.fit() ?? { error: "no fitter" });
      }
      if (method === "GET" && pathname === "/outcomes") {
        requireDefaultRequestProject(runtime, req, url, null, "Global outcome access");
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
        const kind = url.searchParams.get("kind");
        const window = Number.parseInt(url.searchParams.get("windowDays") ?? "7", 10);
        return sendJson(res, 200, {
          aggregate: runtime.outcomes?.aggregate(window) ?? null,
          recent: runtime.outcomes?.recent(limit, kind) ?? []
        });
      }

      if (method === "POST" && pathname === "/feedback") {
        const body = await readJson(req);
        requireDefaultRequestProject(
          runtime,
          req,
          url,
          body,
          "Global outcome feedback"
        );
        const result = runtime.outcomes?.feedback(body.refId, body.qualityScore, body.note);
        if (!result) return sendJson(res, 404, { error: "no outcome found for refId" });
        return sendJson(res, 200, result);
      }

      if (method === "GET" && pathname === "/cron") {
        const project = requireRequestProject(runtime, req, url);
        return sendJson(
          res,
          200,
          runtime.cron.listJobs().filter(
            (job) => (
              (job.input?.projectId ?? "default") === project.id
              && (
                project.id === "default"
                || project.scheduleIds.includes(job.id)
              )
            )
          )
        );
      }
      if (method === "POST" && pathname === "/cron") {
        const body = await readJson(req);
        const project = requireRequestProject(runtime, req, url, {
          projectId: body.projectId ?? body.input?.projectId
        });
        const requestedId = body.id === undefined || body.id === null
          ? null
          : String(body.id);
        const existingJob = requestedId === null
          ? null
          : runtime.cron.listJobs().find((item) => item.id === requestedId) ?? null;
        if (
          existingJob
          && (
            (existingJob.input?.projectId ?? "default") !== project.id
            || (
              project.id !== "default"
              && !project.scheduleIds.includes(existingJob.id)
            )
          )
        ) {
          return sendJson(res, 409, {
            error: "cron job id is not replaceable in the current project"
          });
        }
        const input = {
          ...(body.input ?? {
            prompt: body.prompt ?? "(empty)",
            channel: body.channel ?? "local",
            target: body.target ?? null,
            agentId: body.agentId ?? "main",
            sessionId: body.sessionId
          }),
          projectId: project.id,
          projectRevision: project.revision
        };
        let job = runtime.cron.addJob({
          id: requestedId ?? undefined,
          name: body.name ?? "manual-prompt",
          enabled: body.enabled ?? true,
          task: body.task ?? "prompt",
          replace: true,
          input,
          intervalMs: body.intervalSeconds ? body.intervalSeconds * 1000 : body.intervalMs,
          dailyAt: body.dailyAt,
          nextRunAt: body.delaySeconds ? new Date(Date.now() + body.delaySeconds * 1000).toISOString() : body.nextRunAt
        });
        let attachedByThisCall = !project.scheduleIds.includes(job.id);
        try {
          const attachedProject = runtime.projects?.attachResource?.(
            project.id,
            "scheduleIds",
            job.id,
            { actor: "http:POST:/cron" }
          );
          const pinnedRevision = attachedProject?.revision ?? project.revision;
          if (job.input?.projectRevision !== pinnedRevision) {
            const patch = {
              input: {
                ...job.input,
                projectRevision: pinnedRevision
              }
            };
            job = typeof runtime.cron.updateJob === "function"
              ? runtime.cron.updateJob(job.id, patch)
              : runtime.cron.addJob({ ...job, ...patch, replace: true });
          }
        } catch (error) {
          if (attachedByThisCall) {
            try {
              runtime.projects?.detachResource?.(
                project.id,
                "scheduleIds",
                job.id,
                { actor: "http:POST:/cron:rollback" }
              );
            } catch {
              // Best effort: the orphaned attachment has no runnable job.
            }
          }
          if (existingJob) {
            const restored = runtime.cron.addJob({
              ...existingJob,
              replace: true
            });
            if (existingJob.lastRunAt !== null && existingJob.lastRunAt !== undefined) {
              runtime.cron.updateJob?.(restored.id, {
                lastRunAt: existingJob.lastRunAt
              });
            }
          } else {
            runtime.cron.removeJob?.(job.id);
          }
          throw error;
        }
        events.emit("cron", { op: "add", job });
        return sendJson(res, 200, job);
      }
      if (method === "DELETE" && pathname.startsWith("/cron/")) {
        const project = requireRequestProject(runtime, req, url);
        const id = decodeURIComponent(pathname.slice("/cron/".length));
        const job = runtime.cron.listJobs().find((item) => (
          item.id === id
          && (item.input?.projectId ?? "default") === project.id
          && (
            project.id === "default"
            || project.scheduleIds.includes(item.id)
          )
        ));
        if (!job) return sendJson(res, 404, { error: "unknown-job" });
        const removed = runtime.cron.removeJob(id);
        if (removed) {
          runtime.projects?.detachResource?.(
            project.id,
            "scheduleIds",
            id,
            { actor: "http:DELETE:/cron" }
          );
        }
        events.emit("cron", { op: "remove", id, projectId: project.id });
        return sendJson(res, 200, { removed });
      }
      if (method === "POST" && pathname.match(/^\/cron\/[^/]+\/run$/)) {
        const project = requireRequestProject(runtime, req, url);
        const id = decodeURIComponent(pathname.split("/")[2]);
        const job = runtime.cron.listJobs().find((item) => (
          item.id === id
          && (item.input?.projectId ?? "default") === project.id
          && (
            project.id === "default"
            || project.scheduleIds.includes(item.id)
          )
        ));
        if (!job) return sendJson(res, 404, { error: "unknown-job" });
        const result =
          job.task === "autopilot"
            ? await runtime.runAutopilot(job)
            : await runtime.runScheduledPrompt(job);
        events.emit("cron", { op: "run", id, projectId: project.id, result });
        return sendJson(res, 200, { result });
      }

      if (method === "GET" && pathname === "/skills") {
        const project = requireRequestProject(runtime, req, url);
        const skills = (runtime.skills?.list() ?? [])
          .filter((skill) => projectAllows(project.activeSkills, skill.name));
        return sendJson(res, 200, skills);
      }
      if (method === "GET" && pathname === "/skills/suggested") {
        const project = requireRequestProject(runtime, req, url);
        if (project.id !== "default") {
          return sendJson(res, 403, { error: "Suggested skill administration is default-project only" });
        }
        return sendJson(res, 200, runtime.patternMiner?.list() ?? []);
      }
      // Edit history across all skills (or one, via ?skill=). Feeds the
      // dashboard's "how he improves them" timeline.
      if (method === "GET" && pathname === "/skills/history") {
        const project = requireRequestProject(runtime, req, url);
        const skill = url.searchParams.get("skill");
        if (skill) assertProjectSkill(project, skill);
        const history = runtime.skills?.history(
          skill || null,
          Number(url.searchParams.get("limit") ?? 50)
        ) ?? { edits: [] };
        return sendJson(res, 200, {
          ...history,
          edits: (history.edits ?? []).filter(
            (entry) => projectAllows(project.activeSkills, entry.skill)
          )
        });
      }
      // Full skill view: body + linked files + stats. ?file= reads one
      // linked file. Marked view=0 to skip usage bump for dashboard reads.
      if (method === "GET" && pathname.match(/^\/skills\/[^/]+\/view$/)) {
        const project = requireRequestProject(runtime, req, url);
        const name = decodeURIComponent(pathname.split("/")[2]);
        try {
          assertProjectSkill(project, name);
          const file = url.searchParams.get("file");
          if (!file && url.searchParams.get("count") === "0") {
            // dashboard read — don't inflate usage stats
            const skill = runtime.skills.mustGet(name);
            return sendJson(res, 200, {
              name: skill.name, description: skill.description, category: skill.category,
              pinned: skill.pinned, bundled: skill.bundled ?? false, createdBy: skill.createdBy,
              createdAt: skill.createdAt, sourceSuggestionId: skill.sourceSuggestionId,
              body: skill.body, linkedFiles: skill.linkedFiles ?? [], path: skill.path,
              stats: runtime.skills.statsFor(name)
            });
          }
          return sendJson(res, 200, runtime.skills.view(name, file || null));
        } catch (error) {
          return sendJson(res, 404, { error: error.message });
        }
      }
      if (method === "POST" && pathname === "/skills/create") {
        const body = await readJson(req).catch(() => ({}));
        try {
          const project = requireRequestProject(runtime, req, url, body);
          if (project.id !== "default") {
            return sendJson(res, 403, { error: "Skill definition administration is default-project only" });
          }
          assertProjectSkill(project, body.name);
          const result = runtime.skills.createSkill({ ...body, createdBy: body.createdBy ?? "dashboard" });
          events.emit("skills", { op: "created", skill: result.slug });
          return sendJson(res, 200, result);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }
      if (method === "POST" && pathname.match(/^\/skills\/[^/]+\/edit$/)) {
        const name = decodeURIComponent(pathname.split("/")[2]);
        const body = await readJson(req).catch(() => ({}));
        try {
          const project = requireRequestProject(runtime, req, url, body);
          if (project.id !== "default") {
            return sendJson(res, 403, { error: "Skill definition administration is default-project only" });
          }
          assertProjectSkill(project, name);
          const result = body.old_string !== undefined
            ? runtime.skills.patchSkill(name, body.old_string, body.new_string ?? "", body.by ?? "dashboard")
            : runtime.skills.editSkill(name, body, body.by ?? "dashboard");
          events.emit("skills", { op: "edited", skill: name });
          return sendJson(res, 200, result);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }
      if (method === "POST" && pathname.match(/^\/skills\/[^/]+\/pin$/)) {
        const name = decodeURIComponent(pathname.split("/")[2]);
        const body = await readJson(req).catch(() => ({}));
        try {
          const project = requireRequestProject(runtime, req, url, body);
          if (project.id !== "default") {
            return sendJson(res, 403, { error: "Skill definition administration is default-project only" });
          }
          assertProjectSkill(project, name);
          return sendJson(res, 200, runtime.skills.setPinned(name, body.pinned !== false, body.by ?? "dashboard"));
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }
      if (method === "POST" && pathname.match(/^\/skills\/[^/]+\/delete$/)) {
        const name = decodeURIComponent(pathname.split("/")[2]);
        try {
          const project = requireRequestProject(runtime, req, url);
          if (project.id !== "default") {
            return sendJson(res, 403, { error: "Skill definition administration is default-project only" });
          }
          assertProjectSkill(project, name);
          const result = runtime.skills.deleteSkill(name, "dashboard");
          events.emit("skills", { op: "deleted", skill: name });
          return sendJson(res, 200, result);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }
      if (method === "POST" && pathname.match(/^\/skills\/replay\/[^/]+$/)) {
        const skill = decodeURIComponent(pathname.split("/")[3]);
        const body = await readJson(req).catch(() => ({}));
        try {
          const project = requireRequestProject(runtime, req, url, body);
          assertProjectSkill(project, skill);
          const result = await runtime.skillReplay.run({
            skill,
            dryRun: body.dryRun,
            confirm: body.confirm ?? "first-run",
            projectId: project.id
          });
          return sendJson(res, 200, result);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }
      if (method === "POST" && pathname.match(/^\/skills\/replay-result\/[^/]+$/)) {
        const jobId = decodeURIComponent(pathname.split("/")[3]);
        const body = await readJson(req).catch(() => ({}));
        const project = requireRequestProject(runtime, req, url, body);
        let result;
        try {
          result = runtime.skillReplay.resolveJob(jobId, body, {
            projectId: project.id
          });
        } catch (error) {
          if (error?.code === "INVALID_REPLAY_JOB_ID") {
            return sendJson(res, 400, {
              error: "invalid replay job id",
              code: error.code
            });
          }
          throw error;
        }
        if (!result) return sendJson(res, 404, { error: "unknown job" });
        return sendJson(res, 200, { ok: true });
      }
      if (method === "GET" && pathname === "/skills/replay-jobs") {
        const project = requireRequestProject(runtime, req, url);
        return sendJson(res, 200, runtime.skillReplay.list({
          status: url.searchParams.get("status"),
          projectId: project.id
        }));
      }
      if (method === "POST" && pathname === "/integrations/connect-mcp") {
        // One-click register + connect for catalog entries. Used by the
        // unified Integrations tab so the user doesn't have to fill in
        // the MCP register form for known servers.
        //
        // Body: { catalogId, apiKey? } — apiKey is required when the
        // catalog entry has apiKeyEnvVar AND that env var isn't already
        // populated. We persist the key to .env (under the entry's
        // declared apiKeyEnvVar) so it survives restart, then register
        // the MCP with `${VAR}` indirection — never with a literal.
        const body = await readJson(req).catch(() => ({}));
        const project = requireRequestProject(runtime, req, url, body);
        if (project.id !== "default") {
          return sendSecretsJson(
            res,
            403,
            { error: "MCP catalog administration is default-project only" }
          );
        }
        const catalogId = body.catalogId;
        if (!catalogId) return sendSecretsJson(res, 400, { error: "catalogId required" });
        const { MCP_CATALOG } = await import("./mcp-catalog.js");
        const entry = MCP_CATALOG.find((e) => e.id === catalogId);
        if (!entry) return sendSecretsJson(res, 404, { error: "not in catalog" });
        if (!entry.register) {
          return sendSecretsJson(res, 400, { error: "catalog entry has no register info" });
        }
        try {
          // API-key path: any catalog entry that declares apiKeyEnvVar
          // needs that env var populated before we register, regardless
          // of transport. http+bearer points spec.apiKey at the var;
          // stdio entries already reference it in their args/env block,
          // so we just need it on disk + in the registry's allowlist.
          if (entry.apiKeyEnvVar) {
            const incoming = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
            const existing = isStoredSecretConfigured(runtime.secrets, entry.apiKeyEnvVar, {
              decidedBy: "http:/integrations/connect-mcp:credential-check"
            });
            if (incoming) {
              const { saveEnv } = await import("./setup-wizard.js");
              saveEnv({
                dataDir,
                values: { [entry.apiKeyEnvVar]: incoming },
                store: runtime.secrets,
                decidedBy: "http:/integrations/connect-mcp"
              });
            } else if (!existing) {
              return sendSecretsJson(res, 400, {
                error: `apiKey required (catalog entry '${entry.id}' uses ${entry.apiKeyEnvVar} which isn't set yet)`,
                apiKeyEnvVar: entry.apiKeyEnvVar
              });
            }
            runtime.mcp.allowEnvKey?.(entry.apiKeyEnvVar);
          }
          const spec = { name: entry.id, ...entry.register };
          if (entry.register.auth === "bearer" && entry.apiKeyEnvVar) {
            spec.apiKey = `\${${entry.apiKeyEnvVar}}`;
          }
          const server = runtime.mcp.registerServer(spec);
          if (runtime.mcp?.connect) {
            runtime.mcp.connect(server.name).catch(() => { /* OAuth path surfaces via SSE */ });
          }
          return sendSecretsJson(res, 200, { name: server.name, transport: server.transport });
        } catch {
          return sendSecretsJson(res, 400, { error: "MCP connection setup rejected" });
        }
      }
      if (method === "GET" && pathname === "/pending-actions") {
        const project = requireRequestProject(runtime, req, url);
        const status = url.searchParams.get("status") || undefined;
        return sendJson(res, 200, {
          actions: sanitizeForAudit(
            runtime.pendingActions?.list({
              status,
              projectId: project.id
            }) ?? []
          )
        });
      }
      if (method === "GET" && pathname === "/outreach/feed") {
        const project = requireRequestProject(runtime, req, url);
        const since = Number(url.searchParams.get("since") ?? 0);
        const items = runtime.outreach?.since(since, { projectId: project.id }) ?? [];
        return sendJson(res, 200, { items, cursor: runtime.outreach?.nextSeq ? runtime.outreach.nextSeq - 1 : since });
      }
      if (method === "GET" && pathname === "/outreach/digest") {
        const project = requireRequestProject(runtime, req, url);
        const digest = runtime.outreach
          ?.list({ projectId: project.id })
          .find((i) => i.type === "digest") ?? null;
        return sendJson(res, 200, { digest });
      }
      if (method === "GET" && pathname === "/outreach/config") {
        requireDefaultRequestProject(runtime, req, url, null, "Outreach configuration access");
        const c = runtime.outreachConfig;
        return sendJson(res, 200, c
          ? { enabled: c.enabled, destination: c.destination, cadenceHours: c.cadenceHours, quietHours: c.quietHours, stalledDays: c.stalledDays }
          : { enabled: false });
      }
      if (method === "POST" && pathname.startsWith("/outreach/") && pathname.endsWith("/act")) {
        const body = await readJson(req).catch(() => ({}));
        const project = requireRequestProject(runtime, req, url, body);
        const id = decodeURIComponent(pathname.slice("/outreach/".length, -"/act".length));
        const item = runtime.outreach?.get(id, { projectId: project.id });
        if (!item) return sendJson(res, 404, { error: "unknown outreach item" });
        if (item.status === "acted" || item.status === "dismissed") {
          return sendJson(res, 200, { item });
        }
        const action = String(body.action ?? "");
        try {
          await applyOutreachAction(runtime, item, action, body.note, project.id);
          const status = action === "dismiss" ? "dismissed" : "acted";
          const updated = runtime.outreach.resolve(
            id,
            { action, by: "user", note: body.note ?? null },
            { status, projectId: project.id }
          );
          return sendJson(res, 200, { item: updated });
        } catch (error) {
          const updated = runtime.outreach.resolve(
            id,
            { action, by: "user" },
            {
              status: "error",
              error: error.message,
              projectId: project.id
            }
          );
          return sendJson(res, 400, { item: updated, error: error.message });
        }
      }
      if (method === "POST" && pathname.startsWith("/outreach/") && pathname.endsWith("/feedback")) {
        const body = await readJson(req).catch(() => ({}));
        const project = requireRequestProject(runtime, req, url, body);
        const id = decodeURIComponent(pathname.slice("/outreach/".length, -"/feedback".length));
        const item = runtime.outreach?.get(id, { projectId: project.id });
        if (!item) return sendJson(res, 404, { error: "unknown outreach item" });
        if (item.status === "acted" || item.status === "dismissed") {
          return sendJson(res, 200, { item });
        }
        const verdict = String(body.verdict ?? "");
        if (verdict !== "up" && verdict !== "down") {
          return sendJson(res, 400, { error: "verdict must be 'up' or 'down'" });
        }
        try {
          await applyOutreachFeedback(runtime, item, verdict, body.note ?? null);
          const updated = runtime.outreach.resolve(
            id,
            { action: verdict, by: "user", note: body.note ?? null },
            { status: "acted", projectId: project.id }
          );
          return sendJson(res, 200, { item: updated });
        } catch (error) {
          const updated = runtime.outreach.resolve(
            id,
            { action: verdict, by: "user" },
            {
              status: "error",
              error: error.message,
              projectId: project.id
            }
          );
          return sendJson(res, 400, { item: updated, error: error.message });
        }
      }
      if (method === "POST" && pathname.startsWith("/outreach/") && pathname.endsWith("/reply")) {
        const body = await readJson(req);
        const project = requireRequestProject(runtime, req, url, body);
        const id = decodeURIComponent(pathname.slice("/outreach/".length, -"/reply".length));
        const item = runtime.outreach?.get(id, { projectId: project.id });
        if (!item) return sendJson(res, 404, { error: "unknown outreach item" });
        if (!channels) return sendJson(res, 503, { error: "agent-host-disabled" });
        if (item.outcomeId && runtime.outcomes?.resolve) {
          try {
            runtime.outcomes.resolve(item.outcomeId, inferToneScore(String(body.text ?? "")), "user-followup", "tone of outreach reply");
          } catch { /* best effort */ }
        }
        const forward = `Re: "${item.title}" (${item.type}, actions: ${item.actions.join("/")}).\nUser says: ${body.text ?? ""}\nInterpret intent and take the appropriate action.`;
        const turn = await channels.handleLocalMessage({
          text: forward,
          from: `outreach:${id}`,
          projectId: project.id,
          metadata: {
            projectId: project.id,
            outreachId: id
          }
        });
        return sendJson(res, 200, { reply: turn.reply ?? null });
      }
      if (method === "POST" && pathname.startsWith("/pending-actions/") && pathname.endsWith("/approve")) {
        const project = requireRequestProject(runtime, req, url);
        const id = decodeURIComponent(pathname.slice("/pending-actions/".length, -"/approve".length));
        const action = runtime.pendingActions?.get(id, {
          projectId: project.id
        });
        if (!action) {
          return sendJson(res, 404, { error: "unknown pending action" });
        }
        if (action.status !== "pending") return sendJson(res, 409, { error: `action already ${action.status}` });
        // Resolve a live suspended turn instead of racing it with a second
        // invocation. Restart-era actions without a waiter still execute once.
        const invokeResult = await approvePendingAction(runtime, id, {
          decidedBy: "user",
          approvedVia: "http",
          projectId: project.id
        });
        return sendJson(res, invokeResult.ok ? 200 : 400, invokeResult);
      }
      if (method === "POST" && pathname.startsWith("/pending-actions/") && pathname.endsWith("/deny")) {
        const project = requireRequestProject(runtime, req, url);
        const id = decodeURIComponent(pathname.slice("/pending-actions/".length, -"/deny".length));
        const action = runtime.pendingActions?.get(id, {
          projectId: project.id
        });
        if (!action) {
          return sendJson(res, 404, { error: "unknown pending action" });
        }
        if (action.status !== "pending") return sendJson(res, 409, { error: `action already ${action.status}` });
        const body = await readJson(req).catch(() => ({}));
        runtime.pendingActions.decide(id, {
          decision: "deny",
          decidedBy: "user",
          error: body.reason ?? "denied by user"
        });
        return sendJson(res, 200, { id, status: "denied" });
      }
      if (method === "GET" && pathname === "/auto-approve") {
        requireDefaultRequestProject(runtime, req, url, null, "Approval policy administration");
        // Report current auto-approve state (live env, not cached).
        const { autoApproveEnabled } = await import("./tool-registry.js");
        return sendJson(res, 200, { enabled: autoApproveEnabled() });
      }
      if (method === "POST" && pathname === "/auto-approve") {
        // Flip auto-approve on/off without a daemon restart. Persists to
        // .openagi/.env (allowlisted in WIZARD_FIELDS) and mutates
        // process.env so autoApproveEnabled() sees it immediately.
        const body = await readJson(req).catch(() => ({}));
        requireDefaultRequestProject(
          runtime,
          req,
          url,
          body,
          "Approval policy administration"
        );
        const enable = Boolean(body.enable);
        const { saveEnv } = await import("./setup-wizard.js");
        try {
          saveEnv({
            dataDir,
            values: { OPENAGI_AUTO_APPROVE: enable ? "1" : "0" },
            store: runtime.secrets,
            decidedBy: "http:/auto-approve"
          });
        } catch {
          return sendJson(res, 500, { error: "configuration persistence failed" });
        }
        process.env.OPENAGI_AUTO_APPROVE = enable ? "1" : "0";
        events.emit("auto-approve", { enabled: enable });
        return sendJson(res, 200, { enabled: enable });
      }
      if (method === "GET" && pathname === "/computer-use/log") {
        requireDefaultRequestProject(runtime, req, url, null, "Computer-use administration");
        if (!runtime.computerUseLog) return sendJson(res, 503, { error: "no computer-use log" });
        const limit = Number(url.searchParams.get("limit") ?? 100);
        const sessions = runtime.computerUseLog.listSessions();
        const actions = runtime.computerUseLog.listActions({ limit });
        return sendJson(res, 200, {
          enabled: process.env.OPENAGI_COMPUTER_USE === "1" || process.env.OPENAGI_COMPUTER_USE === "true",
          stats: runtime.computerUseLog.stats(),
          sessions,
          actions
        });
      }
      if (method === "POST" && pathname === "/computer-use/toggle") {
        // Flip OPENAGI_COMPUTER_USE on or off without a daemon restart.
        // Persists to .openagi/.env, mutates process.env, then registers
        // or unregisters the tools dynamically against the live registry.
        // Off-flip ends any active session so the agent doesn't reference
        // a tool that no longer exists on its next turn.
        const body = await readJson(req).catch(() => ({}));
        requireDefaultRequestProject(
          runtime,
          req,
          url,
          body,
          "Computer-use administration"
        );
        const enable = Boolean(body.enable);
        const { saveEnv } = await import("./setup-wizard.js");
        const { registerComputerUseTools, unregisterComputerUseTools } = await import("./integrations/computer-use.js");
        // saveEnv writes only allowlisted keys; OPENAGI_COMPUTER_USE has
        // to be in WIZARD_FIELDS (added in this commit) for the write to
        // land in .env.
        try {
          if (enable) {
            saveEnv({
              dataDir,
              values: { OPENAGI_COMPUTER_USE: "1" },
              store: runtime.secrets,
              decidedBy: "http:/computer-use/toggle"
            });
            process.env.OPENAGI_COMPUTER_USE = "1";
          } else {
            saveEnv({
              dataDir,
              values: {},
              clear: ["OPENAGI_COMPUTER_USE"],
              store: runtime.secrets,
              decidedBy: "http:/computer-use/toggle"
            });
            // saveEnv's clear path also strips process.env, but be explicit:
            delete process.env.OPENAGI_COMPUTER_USE;
          }
        } catch {
          return sendJson(res, 500, { error: "configuration persistence failed" });
        }
        if (enable) {
          registerComputerUseTools(runtime.tools, runtime);
        } else {
          // Close any active session before removing tools.
          const active = runtime.computerUseLog?.listSessions?.({ status: "active" }) ?? [];
          for (const s of active) {
            runtime.computerUseLog.endSession(s.id, { reason: "disabled via toggle", status: "aborted" });
          }
          unregisterComputerUseTools(runtime.tools);
        }
        return sendJson(res, 200, { enabled: enable, tools: enable ? "registered" : "unregistered" });
      }
      if (method === "POST" && pathname.startsWith("/computer-use/sessions/") && pathname.endsWith("/abort")) {
        requireDefaultRequestProject(runtime, req, url, null, "Computer-use administration");
        const id = decodeURIComponent(pathname.slice("/computer-use/sessions/".length, -"/abort".length));
        const session = runtime.computerUseLog?.endSession(id, { reason: "aborted via dashboard", status: "aborted" });
        if (!session) return sendJson(res, 404, { error: "unknown session" });
        return sendJson(res, 200, { id, status: session.status });
      }
      if (method === "POST" && pathname === "/control/restart") {
        requireDefaultRequestProject(runtime, req, url, null, "Daemon administration");
        // Bounce the daemon so .env changes pick up. The Mac app's
        // DaemonController has a terminationHandler that respawns after a
        // short backoff; bare-metal `npm run serve` users will need to
        // re-launch manually. The endpoint returns 202 immediately, then
        // schedules the exit so the response can flush.
        sendJson(res, 202, { restarting: true });
        setTimeout(() => process.exit(0), 200);
        return;
      }
      if (method === "GET" && pathname === "/control/update") {
        requireDefaultRequestProject(runtime, req, url, null, "Daemon administration");
        // Dry check — is a newer version available? (no changes applied)
        const { checkForUpdate } = await import("./self-update.js");
        return sendJson(res, 200, await checkForUpdate());
      }
      if (method === "POST" && pathname === "/control/update") {
        requireDefaultRequestProject(runtime, req, url, null, "Daemon administration");
        // Self-update: fast-forward the checkout, reinstall deps if needed,
        // then exit(0) so the supervisor (systemd Restart=always / launchd
        // KeepAlive / Mac DaemonController) respawns with the new code. No-op
        // with a reason when already current or not fast-forwardable.
        const { applyUpdate } = await import("./self-update.js");
        const result = await applyUpdate();
        sendJson(res, result.updated ? 202 : 200, result);
        if (result.updated) {
          runtime.events?.emit?.("self-update", { at: new Date().toISOString(), from: result.from, to: result.to });
          setTimeout(() => process.exit(0), 300); // respawn with new code
        }
        return;
      }
      if (method === "GET" && pathname === "/integrations/status") {
        requireDefaultRequestProject(runtime, req, url, null, "Integration administration");
        // Unified integrations view. Every source/channel/MCP catalog
        // entry shows up here, with whichever paths apply (API key vs.
        // MCP) so the user has ONE place to configure everything.
        const { MCP_CATALOG, CATEGORIES } = await import("./mcp-catalog.js");
        const registeredMcps = new Set(
          (runtime.mcp?.listServers?.() ?? []).map((s) => (s.name ?? "").toLowerCase())
        );
        const mcpInCatalog = (id) => registeredMcps.has(id) || registeredMcps.has(id.replace(/-/g, ""));
        const integrations = [
          {
            id: "linear",
            name: "Linear",
            description: "Sync your assigned issues as tasks; let the agent search/create issues from chat.",
            paths: [
              {
                kind: "api",
                label: "Direct API (auto-poll)",
                configured: Boolean(runtime.linearTaskSource?.isConfigured?.()),
                envKeys: ["LINEAR_API_KEY"],
                lastSyncedAt: runtime.linearTaskSource?.lastSyncedAt ?? null,
                lastSync: runtime.linearTaskSource?.lastSyncResult ?? null,
                feeds: "tasks",
                detail: "Polls every 5 min. Assigned issues become tasks. Lin priority maps to bucket+priority."
              },
              {
                kind: "mcp",
                label: "MCP (on-demand)",
                catalogId: "linear",
                configured: mcpInCatalog("linear")
              }
            ]
          },
          {
            id: "buildbetter",
            name: "BuildBetter",
            description: "Pull call action items / commitments / follow-ups as tasks. On-demand call search via MCP.",
            paths: [
              {
                kind: "api",
                label: "Direct API (auto-poll)",
                configured: Boolean(runtime.buildBetterTaskSource?.isConfigured?.()),
                envKeys: ["BUILDBETTER_API_KEY", "BUILDBETTER_USER_EMAIL", "BUILDBETTER_USER_NAME"],
                lastSyncedAt: runtime.buildBetterTaskSource?.lastSyncedAt ?? null,
                lastSync: runtime.buildBetterTaskSource?.lastSyncResult ?? null,
                feeds: "tasks",
                detail: "Polls every 15 min. action_item / commitment / follow_up extractions become tasks."
              },
              {
                kind: "mcp",
                label: "MCP (on-demand)",
                catalogId: "buildbetter",
                configured: mcpInCatalog("buildbetter")
              }
            ]
          },
          {
            id: "rize",
            name: "Rize.io",
            description: "Time-tracking. Lets the agent answer 'what did I work on today?' and surface productivity patterns.",
            paths: [
              {
                kind: "api",
                label: "Direct API (agent tools)",
                configured: Boolean(process.env.RIZE_API_KEY),
                envKeys: ["RIZE_API_KEY"],
                feeds: "agent-tools",
                detail: "Adds rize_today_summary / rize_query / rize_recent_sessions agent tools."
              },
              {
                kind: "mcp",
                label: "MCP (on-demand)",
                catalogId: "rize",
                configured: mcpInCatalog("rize")
              }
            ]
          },
          {
            id: "remarkable",
            name: "reMarkable",
            description: "Pull notes + handwritten content from your reMarkable tablet, plus parse task checkboxes.",
            paths: [
              {
                kind: "folder",
                label: "Inbox folder (Dropbox sync)",
                configured: true,
                feeds: "tasks",
                detail: "Drop .md/.txt files into ~/Library/Application Support/OpenAGI/inbox/ — sweeps every 30s for - [ ] checkboxes + TODO: lines. reMarkable → Dropbox sync → this folder is the canonical path. Also works for Obsidian/Bear."
              },
              {
                kind: "mcp",
                label: "reMarkable MCP",
                catalogId: "remarkable",
                configured: mcpInCatalog("remarkable")
              }
            ]
          },
          {
            id: "imessage",
            name: "iMessage (text yourself as inbox)",
            description: "Reads ~/Library/Messages/chat.db read-only and converts messages from a 1:1 self-chat into tasks. macOS only · requires Full Disk Access · opt-in.",
            paths: [
              (() => {
                const s = runtime.imessagePoller?.status?.() ?? null;
                return {
                  kind: "api",
                  label: "Local SQLite poll",
                  configured: Boolean(s?.enabled && s?.readable && s?.selfHandle),
                  envKeys: ["IMESSAGE_ENABLED", "IMESSAGE_SELF_HANDLE", "IMESSAGE_INTERVAL_MS", "IMESSAGE_MODE"],
                  lastSyncedAt: s?.lastSyncedAt ?? null,
                  feeds: "tasks",
                  detail: !s
                    ? "Module not initialized."
                    : !s.enabled
                      ? "Disabled. Set IMESSAGE_ENABLED=1 + IMESSAGE_SELF_HANDLE in .env to turn on."
                      : !s.readable && s.dbExists
                        ? "⚠ Cannot read chat.db — grant Full Disk Access in System Settings → Privacy & Security → Full Disk Access, then restart the daemon."
                        : !s.selfHandle
                          ? "Set IMESSAGE_SELF_HANDLE to the iCloud email or phone you text yourself from."
                          : `Reading from ${s.selfHandle}. Last imported ROWID: ${s.lastImportedRowid ?? 0}.`
                };
              })()
            ]
          },
          {
            id: "telegram",
            name: "Telegram",
            kind: "channel",
            description: "Bot conversations. Webhook or long-polling.",
            paths: [
              {
                kind: "api",
                label: "Bot token",
                configured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
                envKeys: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_POLLING"]
              }
            ]
          },
        ];
        // Featured integrations (BuildBetter, Linear, Rize, …) are ALSO listed
        // in the browse catalog below — intentionally a duplicate, flagged so
        // the UI can say "this is the MCP version of an integration you also
        // have a non-MCP (API) path for above".
        const featuredIds = new Set(integrations.map((i) => i.id));
        const storedSecretNames = configuredSecretNames(runtime.secrets, {
          decidedBy: "http:/integrations/status:credential-check"
        });
        const catalog = MCP_CATALOG
          .map((entry) => ({
            id: entry.id,
            name: entry.name,
            description: entry.description,
            category: entry.category,
            authType: entry.authType,
            status: entry.status,
            apiKeyEnvVar: entry.apiKeyEnvVar ?? null,
            apiKeyHelp: entry.apiKeyHelp ?? null,
            apiKeyConfigured: entry.apiKeyEnvVar
              ? (storedSecretNames === null
                  ? Boolean(process.env[entry.apiKeyEnvVar])
                  : storedSecretNames.has(entry.apiKeyEnvVar))
              : true,
            connectable: entry.status === "available" && Boolean(entry.register),
            configured: mcpInCatalog(entry.id),
            featured: featuredIds.has(entry.id)
          }));
        return sendJson(res, 200, { integrations, catalog, categories: CATEGORIES });
      }
      if (method === "GET" && pathname === "/kanban") {
        if (!runtime.kanban?.boardView) return sendJson(res, 503, { error: "no Kanban store" });
        const project = requireRequestProject(runtime, req, url);
        const requestedBoard = url.searchParams.get("board") || undefined;
        if (requestedBoard && requestedBoard !== project.kanbanBoardId) {
          return sendJson(res, 403, { error: "Kanban board is outside the current project" });
        }
        const board = project.kanbanBoardId;
        const status = url.searchParams.get("status") || undefined;
        const assignee = url.searchParams.get("assignee") || undefined;
        const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined;
        try {
          return sendJson(res, 200, await runtime.kanban.boardView({ board, status, assignee, limit }));
        } catch (error) {
          const statusCode = /^Unknown Kanban task:/.test(error.message) ? 404 : 400;
          return sendJson(res, statusCode, { error: error.message });
        }
      }
      if (method === "POST" && pathname === "/kanban") {
        if (!runtime.kanban?.createTask) return sendJson(res, 503, { error: "no Kanban store" });
        const body = await readJson(req);
        const project = requireRequestProject(runtime, req, url, body);
        const action = String(body.action ?? "create").trim().toLowerCase();
        const context = projectToolContext(project, {
          agentId: "dashboard",
          sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
          channel: "local",
          from: "http:/kanban"
        });
        try {
          let result;
          if (action === "create") {
            const { action: _action, sessionId: _sessionId, ...input } = body;
            if (input.board && input.board !== project.kanbanBoardId) {
              return sendJson(res, 403, { error: "Kanban board is outside the current project" });
            }
            for (const blockerId of input.blockedBy ?? []) {
              await requireProjectKanbanTask(runtime, project, blockerId);
            }
            result = await runtime.kanban.createTask({
              ...input,
              board: project.kanbanBoardId
            }, context);
          } else if (action === "assign") {
            await requireProjectKanbanTask(runtime, project, body.taskId);
            result = await runtime.kanban.assignTask(
              body.taskId,
              body.assignee,
              context,
              { reason: body.reason }
            );
          } else if (action === "complete") {
            await requireProjectKanbanTask(runtime, project, body.taskId);
            result = await runtime.kanban.completeTask(body.taskId, body, context);
          } else if (action === "block") {
            await requireProjectKanbanTask(runtime, project, body.taskId);
            for (const blockerId of body.blockedBy ?? []) {
              await requireProjectKanbanTask(runtime, project, blockerId);
            }
            result = await runtime.kanban.blockTask(body.taskId, body, context);
          } else if (action === "unblock") {
            await requireProjectKanbanTask(runtime, project, body.taskId);
            if (body.blockerId) {
              await requireProjectKanbanTask(runtime, project, body.blockerId);
            }
            result = await runtime.kanban.unblockTask(body.taskId, body, context);
          } else if (action === "comment") {
            await requireProjectKanbanTask(runtime, project, body.taskId);
            result = await runtime.kanban.commentTask(body.taskId, body.body, context);
          } else if (action === "heartbeat") {
            await requireProjectKanbanTask(runtime, project, body.taskId);
            result = await runtime.kanban.heartbeatTask(body.taskId, body, context);
          } else if (action === "move") {
            // Parity with the kanban_move tool. Without this the new
            // 'on-hold' column and every backwards move were reachable by an
            // agent but not by the dashboard or CLI, so the two surfaces
            // disagreed about what the board can do. Terminal and blocked
            // transitions are still refused by the store itself, so this route
            // cannot be used to skip the completion handoff or the blocker
            // bookkeeping.
            await requireProjectKanbanTask(runtime, project, body.taskId);
            result = await runtime.kanban.moveTask(
              body.taskId,
              body.status,
              context,
              { reason: body.reason }
            );
          } else if (action === "link") {
            await requireProjectKanbanTask(runtime, project, body.parentId);
            await requireProjectKanbanTask(runtime, project, body.childId);
            result = await runtime.kanban.linkTasks(body.parentId, body.childId, context);
          } else {
            return sendJson(res, 400, { error: `unknown Kanban action: ${action}` });
          }
          return sendJson(res, 200, result);
        } catch (error) {
          const statusCode = /^Unknown Kanban task:/.test(error.message) ? 404 : 400;
          return sendJson(res, statusCode, { error: error.message });
        }
      }
      if (method === "GET" && pathname.match(/^\/kanban\/[^/]+$/)) {
        if (!runtime.kanban?.getTask) return sendJson(res, 503, { error: "no Kanban store" });
        const project = requireRequestProject(runtime, req, url);
        const id = decodeURIComponent(pathname.split("/")[2]);
        try {
          const task = await requireProjectKanbanTask(runtime, project, id);
          return task
            ? sendJson(res, 200, task)
            : sendJson(res, 404, { error: "unknown Kanban task" });
        } catch (error) {
          const statusCode = /^Unknown Kanban task:/.test(error.message) ? 404 : 400;
          return sendJson(res, statusCode, { error: error.message });
        }
      }
      if (method === "GET" && pathname === "/tasks") {
        requireDefaultRequestProject(runtime, req, url, null, "Legacy task access");
        if (!runtime.tasks?.list) return sendJson(res, 503, { error: "no task store" });
        const queue = url.searchParams.get("queue") || undefined;
        const bucket = url.searchParams.get("bucket") || undefined;
        const status = url.searchParams.get("status") || undefined;
        const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined;
        return sendJson(res, 200, {
          tasks: runtime.tasks.list({ queue, bucket, status, limit }),
          stats: runtime.tasks.stats()
        });
      }
      if (method === "POST" && pathname === "/tasks") {
        const body = await readJson(req);
        requireDefaultRequestProject(runtime, req, url, body, "Legacy task administration");
        if (!runtime.tasks?.add) return sendJson(res, 503, { error: "no task store" });
        try {
          const task = runtime.tasks.add(body, { source: body.source ?? "manual", queue: body.queue ?? "user" });
          return sendJson(res, 200, task);
        } catch (error) { return sendJson(res, 400, { error: error.message }); }
      }
      if (method === "PATCH" && pathname.match(/^\/tasks\/[^/]+$/)) {
        const id = decodeURIComponent(pathname.split("/")[2]);
        const body = await readJson(req);
        requireDefaultRequestProject(runtime, req, url, body, "Legacy task administration");
        if (!runtime.tasks?.update) return sendJson(res, 503, { error: "no task store" });
        const task = runtime.tasks.update(id, body);
        return task ? sendJson(res, 200, task) : sendJson(res, 404, { error: "unknown task" });
      }
      if (method === "POST" && pathname.match(/^\/tasks\/[^/]+\/complete$/)) {
        const id = decodeURIComponent(pathname.split("/")[2]);
        const body = await readJson(req).catch(() => ({}));
        requireDefaultRequestProject(runtime, req, url, body, "Legacy task administration");
        const task = runtime.tasks.complete(id, body.completedVia ?? "manual");
        return task ? sendJson(res, 200, task) : sendJson(res, 404, { error: "unknown task" });
      }
      if (method === "DELETE" && pathname.match(/^\/tasks\/[^/]+$/)) {
        requireDefaultRequestProject(runtime, req, url, null, "Legacy task administration");
        const id = decodeURIComponent(pathname.split("/")[2]);
        const ok = runtime.tasks.remove(id);
        return sendJson(res, ok ? 200 : 404, { ok, id });
      }
      // Clarification queue — the "ask me" loop. ids are looked up in an
      // in-memory Map (never a filesystem path), so the strict-id concern
      // from suggestion routes doesn't apply here.
      if (method === "GET" && pathname === "/tasks/reconciliation/calibration") {
        requireDefaultRequestProject(runtime, req, url, null, "Task calibration access");
        // Transparency: how the auto-complete threshold has self-tuned from
        // the user's clarification answers, per evidence-source combo.
        const { buildReconciliationCalibration } = await import("./reconciliation-calibration.js");
        const outcomes = runtime.outcomes?.recent?.(200, "clarification-answered") ?? [];
        return sendJson(res, 200, buildReconciliationCalibration(outcomes).summary);
      }
      if (method === "GET" && pathname === "/tasks/clarifications") {
        requireDefaultRequestProject(runtime, req, url, null, "Clarification access");
        if (!runtime.clarifications?.list) return sendJson(res, 503, { error: "no clarification store" });
        const status = url.searchParams.get("status");
        return sendJson(res, 200, runtime.clarifications.list({ status: status === "null" ? null : (status ?? "pending") }));
      }
      if (method === "POST" && pathname.match(/^\/tasks\/clarifications\/[^/]+\/answer$/)) {
        const id = decodeURIComponent(pathname.split("/")[3]);
        const body = await readJson(req).catch(() => ({}));
        requireDefaultRequestProject(runtime, req, url, body, "Clarification administration");
        if (!runtime.clarifications?.answer) return sendJson(res, 503, { error: "no clarification store" });
        try {
          const result = runtime.clarifications.answer(id, body.answer);
          return result ? sendJson(res, 200, result) : sendJson(res, 404, { error: "unknown or already-resolved clarification" });
        } catch (error) { return sendJson(res, 400, { error: error.message }); }
      }
      // Drafts review queue — agent-produced artifacts awaiting approval.
      // ids are Map keys, never fs paths → no traversal surface.
      // Versioned Artifact Canvas. All methods are authenticated and project-scoped.
      if (method === "GET" && pathname === "/artifacts") {
        if (!runtime.artifacts?.list) {
          return sendJson(res, 503, { error: "artifact Canvas unavailable" });
        }
        const project = requireRequestProject(runtime, req, url);
        try {
          const limitValue = url.searchParams.get("limit");
          const limit = limitValue == null ? undefined : Number(limitValue);
          return sendJson(res, 200, runtime.artifacts.list({
            projectId: project.id,
            ...(url.searchParams.has("kind")
              ? { kind: url.searchParams.get("kind") }
              : {}),
            ...(limit == null ? {} : { limit })
          }));
        } catch (error) {
          return sendArtifactHttpError(res, error);
        }
      }
      if (method === "POST" && pathname === "/artifacts") {
        if (!runtime.artifacts?.create) {
          return sendJson(res, 503, { error: "artifact Canvas unavailable" });
        }
        const body = await readJson(req).catch(() => null);
        const project = requireRequestProject(runtime, req, url);
        try {
          const artifact = runtime.artifacts.create({
            ...(body ?? {}),
            projectId: project.id
          }, {
            projectId: project.id,
            actor: "http"
          });
          return sendJson(res, 201, artifact);
        } catch (error) {
          return sendArtifactHttpError(res, error);
        }
      }
      if (method === "GET" && /^\/artifacts\/[^/]+\/versions$/u.test(pathname)) {
        if (!runtime.artifacts?.versions) {
          return sendJson(res, 503, { error: "artifact Canvas unavailable" });
        }
        const project = requireRequestProject(runtime, req, url);
        const id = decodeURIComponent(
          pathname.slice("/artifacts/".length, -"/versions".length)
        );
        try {
          const limitValue = url.searchParams.get("limit");
          const limit = limitValue == null ? undefined : Number(limitValue);
          return sendJson(res, 200, runtime.artifacts.versions(id, {
            projectId: project.id,
            ...(limit == null ? {} : { limit }),
            includeContent: url.searchParams.get("includeContent") === "1"
          }));
        } catch (error) {
          return sendArtifactHttpError(res, error);
        }
      }
      if (method === "POST" && /^\/artifacts\/[^/]+\/restore$/u.test(pathname)) {
        if (!runtime.artifacts?.restore) {
          return sendJson(res, 503, { error: "artifact Canvas unavailable" });
        }
        const project = requireRequestProject(runtime, req, url);
        const id = decodeURIComponent(
          pathname.slice("/artifacts/".length, -"/restore".length)
        );
        const body = await readJson(req).catch(() => null);
        try {
          const artifact = runtime.artifacts.restore(
            id,
            body?.revision ?? body?.targetRevision,
            {
              projectId: project.id,
              expectedRevision: body?.expectedRevision,
              actor: "http"
            }
          );
          return sendJson(res, 200, artifact);
        } catch (error) {
          return sendArtifactHttpError(res, error);
        }
      }
      if (method === "GET" && /^\/artifacts\/[^/]+$/u.test(pathname)) {
        if (!runtime.artifacts?.get) {
          return sendJson(res, 503, { error: "artifact Canvas unavailable" });
        }
        const project = requireRequestProject(runtime, req, url);
        const id = decodeURIComponent(pathname.slice("/artifacts/".length));
        try {
          const revisionValue = url.searchParams.get("revision");
          const revision = revisionValue == null ? undefined : Number(revisionValue);
          return sendJson(res, 200, runtime.artifacts.get(id, {
            projectId: project.id,
            ...(revision == null ? {} : { revision })
          }));
        } catch (error) {
          return sendArtifactHttpError(res, error);
        }
      }
      if (method === "PATCH" && /^\/artifacts\/[^/]+$/u.test(pathname)) {
        if (!runtime.artifacts?.update) {
          return sendJson(res, 503, { error: "artifact Canvas unavailable" });
        }
        const project = requireRequestProject(runtime, req, url);
        const id = decodeURIComponent(pathname.slice("/artifacts/".length));
        const body = await readJson(req).catch(() => null);
        try {
          const artifact = runtime.artifacts.update(id, {
            ...(body ?? {}),
            projectId: project.id
          }, {
            projectId: project.id,
            actor: "http"
          });
          return sendJson(res, 200, artifact);
        } catch (error) {
          return sendArtifactHttpError(res, error);
        }
      }
      // Procedural recipe memory. Factual memory remains on the separate
      // /memory and recall surfaces.
      if (method === "GET" && pathname === "/recipes/index") {
        if (!runtime.recipes?.indexStatus) {
          return sendJson(res, 503, { error: "recipe memory unavailable" });
        }
        const project = requireRequestProject(runtime, req, url);
        try {
          return sendJson(res, 200, runtime.recipes.indexStatus({
            projectId: project.id
          }));
        } catch (error) {
          return sendRecipeHttpError(res, error);
        }
      }
      if (method === "POST" && pathname === "/recipes/reindex") {
        if (!runtime.recipes?.reindex) {
          return sendJson(res, 503, { error: "recipe memory unavailable" });
        }
        const body = await readJson(req).catch(() => ({}));
        const project = requireRequestProject(runtime, req, url, body);
        try {
          return sendJson(res, 200, await runtime.recipes.reindex({
            projectId: project.id,
            actor: "http"
          }));
        } catch (error) {
          return sendRecipeHttpError(res, error);
        }
      }
      if (method === "GET" && pathname === "/recipes/export") {
        if (!runtime.recipes?.export) {
          return sendJson(res, 503, { error: "recipe memory unavailable" });
        }
        const project = requireRequestProject(runtime, req, url);
        try {
          return sendJson(res, 200, runtime.recipes.export({
            projectId: project.id,
            format: url.searchParams.get("format") ?? "json",
            statuses: httpRecipeStatuses(url.searchParams.get("status")),
            includeDeleted: url.searchParams.get("includeDeleted") === "1"
          }));
        } catch (error) {
          return sendRecipeHttpError(res, error);
        }
      }
      if (method === "GET" && pathname === "/recipes") {
        if (!runtime.recipes?.search) {
          return sendJson(res, 503, { error: "recipe memory unavailable" });
        }
        const project = requireRequestProject(runtime, req, url);
        try {
          const items = runtime.recipes.search(
            url.searchParams.get("q") ?? "",
            {
              projectId: project.id,
              statuses: httpRecipeStatuses(url.searchParams.get("status")),
              includeDeleted: url.searchParams.get("includeDeleted") === "1",
              limit: url.searchParams.has("limit")
                ? Number(url.searchParams.get("limit"))
                : undefined
            }
          );
          return sendJson(res, 200, { count: items.length, items });
        } catch (error) {
          return sendRecipeHttpError(res, error);
        }
      }
      if (method === "POST" && pathname === "/recipes") {
        if (!runtime.recipes?.propose) {
          return sendJson(res, 503, { error: "recipe memory unavailable" });
        }
        const body = await readJson(req).catch(() => null);
        const project = requireRequestProject(runtime, req, url, body);
        try {
          const recipe = runtime.recipes.propose({
            ...(body ?? {}),
            projectId: project.id
          }, {
            projectId: project.id,
            actor: "http"
          });
          return sendJson(res, 201, recipe);
        } catch (error) {
          return sendRecipeHttpError(res, error);
        }
      }
      if (method === "GET" && /^\/recipes\/[^/]+\/export$/u.test(pathname)) {
        if (!runtime.recipes?.export) {
          return sendJson(res, 503, { error: "recipe memory unavailable" });
        }
        const project = requireRequestProject(runtime, req, url);
        const id = decodeURIComponent(
          pathname.slice("/recipes/".length, -"/export".length)
        );
        try {
          return sendJson(res, 200, runtime.recipes.export({
            id,
            projectId: project.id,
            format: url.searchParams.get("format") ?? "json",
            includeDeleted: true
          }));
        } catch (error) {
          return sendRecipeHttpError(res, error);
        }
      }
      if (method === "POST" && /^\/recipes\/[^/]+\/verify$/u.test(pathname)) {
        if (!runtime.recipes?.verify) {
          return sendJson(res, 503, { error: "recipe memory unavailable" });
        }
        const body = await readJson(req).catch(() => null);
        const project = requireRequestProject(runtime, req, url, body);
        const id = decodeURIComponent(
          pathname.slice("/recipes/".length, -"/verify".length)
        );
        try {
          return sendJson(res, 200, await runtime.recipes.verify(id, {
            expectedRevision: body?.expectedRevision,
            method: body?.method,
            evidence: body?.evidence
          }, {
            projectId: project.id,
            actor: "http"
          }));
        } catch (error) {
          return sendRecipeHttpError(res, error);
        }
      }
      if (method === "POST" && /^\/recipes\/[^/]+\/fail$/u.test(pathname)) {
        if (!runtime.recipes?.fail) {
          return sendJson(res, 503, { error: "recipe memory unavailable" });
        }
        const body = await readJson(req).catch(() => null);
        const project = requireRequestProject(runtime, req, url, body);
        const id = decodeURIComponent(
          pathname.slice("/recipes/".length, -"/fail".length)
        );
        try {
          return sendJson(res, 200, runtime.recipes.fail(id, {
            expectedRevision: body?.expectedRevision,
            reason: body?.reason,
            evidence: body?.evidence
          }, {
            projectId: project.id,
            actor: "http"
          }));
        } catch (error) {
          return sendRecipeHttpError(res, error);
        }
      }
      if (method === "POST" && /^\/recipes\/[^/]+\/supersede$/u.test(pathname)) {
        if (!runtime.recipes?.supersede) {
          return sendJson(res, 503, { error: "recipe memory unavailable" });
        }
        const body = await readJson(req).catch(() => null);
        const project = requireRequestProject(runtime, req, url, body);
        const id = decodeURIComponent(
          pathname.slice("/recipes/".length, -"/supersede".length)
        );
        try {
          return sendJson(res, 200, runtime.recipes.supersede(
            id,
            body?.replacementId,
            {
              projectId: project.id,
              expectedRevision: body?.expectedRevision,
              replacementExpectedRevision: body?.replacementExpectedRevision,
              actor: "http"
            }
          ));
        } catch (error) {
          return sendRecipeHttpError(res, error);
        }
      }
      if (
        method === "POST"
        && /^\/recipes\/[^/]+\/skill-candidate$/u.test(pathname)
      ) {
        if (!runtime.recipes?.withVerifiedRecipe) {
          return sendJson(res, 503, { error: "recipe memory unavailable" });
        }
        const body = await readJson(req).catch(() => null);
        const project = requireRequestProject(runtime, req, url, body);
        const id = decodeURIComponent(
          pathname.slice("/recipes/".length, -"/skill-candidate".length)
        );
        try {
          const { createSkillCandidateFromRecipe } = await import(
            "./skill-materialize.js"
          );
          const staged = runtime.recipes.withVerifiedRecipe(
            id,
            {
              projectId: project.id,
              expectedRevision: body?.expectedRevision
            },
            (recipe) => createSkillCandidateFromRecipe({ runtime, recipe })
          );
          events.emit("skill-candidate", {
            source: "recipe-memory",
            id: staged.candidate.id,
            recipeId: id,
            recipeRevision: body?.expectedRevision,
            projectId: project.id
          });
          return sendJson(res, staged.created ? 201 : 200, {
            id: staged.candidate.id,
            source: "recipe-memory",
            recipeId: id,
            recipeRevision: body?.expectedRevision,
            projectId: project.id,
            created: staged.created,
            status: staged.candidate.status
          });
        } catch (error) {
          return sendRecipeHttpError(res, error);
        }
      }
      if (method === "GET" && /^\/recipes\/[^/]+$/u.test(pathname)) {
        if (!runtime.recipes?.get) {
          return sendJson(res, 503, { error: "recipe memory unavailable" });
        }
        const project = requireRequestProject(runtime, req, url);
        const id = decodeURIComponent(pathname.slice("/recipes/".length));
        try {
          return sendJson(res, 200, runtime.recipes.get(id, {
            projectId: project.id
          }));
        } catch (error) {
          return sendRecipeHttpError(res, error);
        }
      }
      if (method === "PATCH" && /^\/recipes\/[^/]+$/u.test(pathname)) {
        if (!runtime.recipes?.edit) {
          return sendJson(res, 503, { error: "recipe memory unavailable" });
        }
        const body = await readJson(req).catch(() => null);
        const project = requireRequestProject(runtime, req, url, body);
        const id = decodeURIComponent(pathname.slice("/recipes/".length));
        try {
          return sendJson(res, 200, runtime.recipes.edit(id, {
            ...(body ?? {}),
            projectId: project.id
          }, {
            projectId: project.id,
            actor: "http"
          }));
        } catch (error) {
          return sendRecipeHttpError(res, error);
        }
      }
      if (method === "DELETE" && /^\/recipes\/[^/]+$/u.test(pathname)) {
        if (!runtime.recipes?.remove) {
          return sendJson(res, 503, { error: "recipe memory unavailable" });
        }
        const body = await readJson(req).catch(() => ({}));
        const project = requireRequestProject(runtime, req, url, body);
        const id = decodeURIComponent(pathname.slice("/recipes/".length));
        try {
          return sendJson(res, 200, runtime.recipes.remove(id, {
            projectId: project.id,
            expectedRevision: body?.expectedRevision,
            actor: "http"
          }));
        } catch (error) {
          return sendRecipeHttpError(res, error);
        }
      }
      // Draft review queue.
      if (method === "GET" && pathname === "/drafts") {
        if (!runtime.drafts?.list) return sendJson(res, 503, { error: "no draft store" });
        const project = requireRequestProject(runtime, req, url);
        const status = url.searchParams.get("status");
        return sendJson(res, 200, runtime.drafts.list({
          status: status === "null" ? null : (status ?? "pending"),
          projectId: project.id
        }));
      }
      if (method === "PATCH" && pathname.match(/^\/drafts\/[^/]+$/)) {
        if (!runtime.drafts?.edit) return sendJson(res, 503, { error: "no draft store" });
        const project = requireRequestProject(runtime, req, url);
        const id = decodeURIComponent(pathname.split("/")[2]);
        const body = await readJson(req).catch(() => ({}));
        const draft = runtime.drafts.edit(id, body, { projectId: project.id });
        return draft ? sendJson(res, 200, draft) : sendJson(res, 404, { error: "unknown or already-resolved draft" });
      }
      if (method === "POST" && pathname.match(/^\/drafts\/[^/]+\/(approve|discard)$/)) {
        if (!runtime.drafts) return sendJson(res, 503, { error: "no draft store" });
        const project = requireRequestProject(runtime, req, url);
        const parts = pathname.split("/");
        const id = decodeURIComponent(parts[2]);
        const action = parts[3];
        const draft = action === "approve"
          ? runtime.drafts.approve(id, { projectId: project.id })
          : runtime.drafts.discard(id, { projectId: project.id });
        return draft ? sendJson(res, 200, draft) : sendJson(res, 404, { error: "unknown or already-resolved draft" });
      }
      if (method === "POST" && pathname.match(/^\/drafts\/[^/]+\/send$/)) {
        // Explicit user-initiated send: route the draft body through a REAL
        // outbound transport (telegram). This is the only path that
        // transmits externally; it's a deliberate dashboard action, not the
        // agent. We only mark the draft "sent" if delivery actually confirms.
        if (!runtime.drafts?.get) return sendJson(res, 503, { error: "no draft store" });
        if (!runtime.channels?.deliver) return sendJson(res, 503, { error: "no outbound channels" });
        const project = requireRequestProject(runtime, req, url);
        const id = decodeURIComponent(pathname.split("/")[2]);
        const draft = runtime.drafts.get(id, { projectId: project.id });
        if (!draft) return sendJson(res, 404, { error: "unknown draft" });
        if (draft.status === "sent") return sendJson(res, 409, { error: "draft already sent" });
        if (draft.status === "discarded") return sendJson(res, 409, { error: "draft was discarded" });
        const body = await readJson(req).catch(() => ({}));
        const channel = body.channel;
        const target = body.target ?? draft.recipient;
        if (channel !== "telegram") {
          return sendJson(res, 400, { error: "send requires channel 'telegram' (email has no native transport — copy the approved draft into your mail client)" });
        }
        if (!target) return sendJson(res, 400, { error: "no target/recipient for this send" });
        let result;
        try {
          result = await runtime.channels.deliver({
            channel,
            target,
            text: draft.body,
            projectId: project.id,
            refId: draft.id
          });
        } catch (error) { return sendJson(res, 502, { error: error.message }); }
        if (result?.delivered === false) {
          return sendJson(res, 502, { error: result.reason ?? "delivery failed", result });
        }
        const sent = runtime.drafts.markSent(id, {
          channel,
          target,
          result,
          projectId: project.id
        });
        return sendJson(res, 200, { sent, result });
      }
      if (method === "POST" && pathname.match(/^\/tasks\/clarifications\/[^/]+\/dismiss$/)) {
        requireDefaultRequestProject(runtime, req, url, null, "Clarification administration");
        if (!runtime.clarifications?.dismiss) return sendJson(res, 503, { error: "no clarification store" });
        const id = decodeURIComponent(pathname.split("/")[3]);
        const item = runtime.clarifications.dismiss(id);
        return item ? sendJson(res, 200, item) : sendJson(res, 404, { error: "unknown or already-resolved clarification" });
      }
      if (method === "GET" && pathname === "/proactive/suggestions") {
        requireDefaultRequestProject(runtime, req, url, null, "Proactive suggestion access");
        // Story 4: merge observer suggestions + miner candidates. Both go
        // through the unified envelope so the dashboard renders them with
        // the same card shape; source badge tells them apart.
        const { listAllSuggestions } = await import("./suggestion-feed.js");
        const status = url.searchParams.get("status");
        return sendJson(res, 200, listAllSuggestions(runtime, {
          status: status === "null" ? null : (status ?? "pending")
        }));
      }
      if (method === "POST" && pathname === "/proactive/observe") {
        const body = await readJson(req).catch(() => ({}));
        requireDefaultRequestProject(runtime, req, url, body, "Proactive observer control");
        if (!runtime.proactiveObserver?.observe) return sendJson(res, 503, { error: "no observer" });
        try {
          const result = await runtime.proactiveObserver.observe({ force: true });
          return sendJson(res, 200, result);
        } catch (error) { return sendJson(res, 500, { error: error.message }); }
      }
      if (
        method === "POST"
        && pathname.match(
          /^\/proactive\/suggestions\/[^/]+\/(accept|edit|defer|reject|dismiss)$/
        )
      ) {
        const body = await readJson(req).catch(() => ({}));
        requireDefaultRequestProject(
          runtime,
          req,
          url,
          body,
          "Proactive suggestion administration"
        );
        const parts = pathname.split("/");
        const id = decodeURIComponent(parts[3]);
        const action = parts[4];
        const status = action === "accept"
          ? "accepted"
          : action === "edit"
            ? "edited"
            : action === "defer"
              ? "deferred"
              : action === "reject"
                ? "rejected"
                : "dismissed";
        // Story 4: status writes go through the unified feed so they
        // land in the right source file (observer OR miner). Same id
        // namespace; resolveSuggestion locates the file by id.
        const { resolveSuggestion } = await import("./suggestion-feed.js");
        let candidate;
        try {
          candidate = resolveSuggestion(runtime, id, status, status === "edited"
            ? {
                name: body.name,
                body: body.body,
                note: body.note ?? null
              }
            : (body.note ?? body.reason ?? null));
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
        if (!candidate) return sendJson(res, 404, { error: "unknown suggestion" });
        // Let any open dashboard refresh its Suggestions tab live.
        events.emit("suggestion-resolved", { id, status, category: candidate.category ?? null });

        // For MCP suggestions, accepting auto-registers + connects the server.
        if (status === "accepted" && candidate.category === "mcp" && candidate.mcpRegister && runtime.mcp?.registerServer) {
          try {
            const reg = candidate.mcpRegister;
            const name = candidate.mcpId ?? candidate.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
            runtime.mcp.registerServer({ name, ...reg });
            runtime.mcp.connect?.(name).catch(() => { /* OAuth path surfaces via SSE */ });
            return sendJson(res, 200, { ...candidate, registered: name });
          } catch (error) {
            return sendJson(res, 200, { ...candidate, registerError: error.message });
          }
        }
        // For task suggestions, accepting creates the task in the right
        // queue + bucket — through the same materializer the observer's
        // OPENAGI_AUTO_TASKS=1 path uses, so dedup (by suggestionId) and the
        // draft-only guardrails for agent-queue tasks apply identically.
        if (status === "accepted" && candidate.category === "task" && runtime.tasks?.add) {
          const { materializeTaskFromSuggestion } = await import("./proactive-observer.js");
          const task = materializeTaskFromSuggestion(runtime, candidate);
          if (!task) return sendJson(res, 200, { ...candidate, taskCreateError: "could not create task" });
          return sendJson(res, 200, { ...candidate, taskId: task.id });
        }
        // Story 1 + 6: accepting a skill suggestion materializes it into
        // a real SKILL.md file under the user skills dir. Dispatches by
        // source: observer suggestions use createSkillFromSuggestion
        // (Story 1 shape — flat title + draftBody), miner candidates use
        // createSkillFromCandidate (Story 6 shape — proposal.body +
        // sequence stats + scheduleHint). Both write to the same dir.
        if (
          (status === "accepted" || status === "edited")
          && candidate.category === "skill"
          && runtime.skills?.reload
        ) {
          try {
            const { createSkillFromSuggestion, createSkillFromCandidate } = await import("./skill-materialize.js");
            const isMined = candidate.source === "pattern-miner"
              || candidate.source === "session-miner"
              || candidate.source === "recipe-memory";
            const result = isMined
              ? createSkillFromCandidate({ runtime, candidate })
              : createSkillFromSuggestion({ runtime, suggestion: candidate });
            runtime.skills.reload();
            return sendJson(res, 200, {
              ...candidate,
              skillSlug: result.slug,
              skillPath: result.path,
              scheduleHint: result.scheduleHint ?? null,
              triggerHint: result.triggerHint ?? null,
              // When the candidate had a scheduleHint, the dashboard
              // asks the user whether to also create a cron job.
              requiresScheduleConfirm: Boolean(result.scheduleHint)
            });
          } catch (error) {
            return sendJson(res, 200, { ...candidate, skillCreateError: error.message });
          }
        }
        return sendJson(res, 200, candidate);
      }
      if (method === "POST" && pathname.match(/^\/skills\/[^/]+\/schedule$/)) {
        // Story 6: follow-up after accepting a miner candidate with
        // scheduleHint. User confirms (or skips) creating a cron job
        // that fires the new skill at the hinted time.
        const slug = decodeURIComponent(pathname.split("/")[2]);
        const body = await readJson(req).catch(() => ({}));
        const project = requireRequestProject(runtime, req, url, body);
        try {
          assertProjectSkill(project, slug);
          runtime.skills?.mustGet?.(slug);
        } catch (error) {
          return sendJson(res, 403, { error: error.message });
        }
        if (!body.dailyAt) return sendJson(res, 400, { error: "dailyAt required, e.g. \"09:00\"" });
        if (!runtime.cron?.addJob) return sendJson(res, 503, { error: "no cron scheduler" });
        const jobId = projectSkillScheduleId(project.id, slug);
        const existingJob = runtime.cron.listJobs?.()
          .find((item) => item.id === jobId) ?? null;
        if (
          existingJob
          && (
            (existingJob.input?.projectId ?? "default") !== project.id
            || (
              project.id !== "default"
              && !project.scheduleIds.includes(existingJob.id)
            )
          )
        ) {
          return sendJson(res, 409, {
            error: "skill schedule id belongs to another project"
          });
        }
        const input = {
          prompt: `Run the "${slug}" skill.`,
          channel: "local",
          target: null,
          projectId: project.id,
          projectRevision: project.revision
        };
        let job = existingJob
          ? runtime.cron.updateJob(jobId, {
              name: `Auto-fire skill: ${slug}`,
              enabled: true,
              task: "prompt",
              dailyAt: body.dailyAt,
              input
            })
          : runtime.cron.addJob({
              id: jobId,
              name: `Auto-fire skill: ${slug}`,
              enabled: true,
              task: "prompt",
              dailyAt: body.dailyAt,
              input
            });
        let attachedByThisCall = false;
        try {
          attachedByThisCall = !project.scheduleIds.includes(job.id);
          const attachedProject = runtime.projects?.attachResource?.(
            project.id,
            "scheduleIds",
            job.id,
            { actor: "http:POST:/skills/schedule" }
          );
          const pinnedRevision = attachedProject?.revision ?? project.revision;
          if (job.input?.projectRevision !== pinnedRevision) {
            job = runtime.cron.updateJob(job.id, {
              input: {
                ...job.input,
                projectRevision: pinnedRevision
              }
            });
          }
        } catch (error) {
          if (attachedByThisCall) {
            try {
              runtime.projects?.detachResource?.(
                project.id,
                "scheduleIds",
                job.id,
                { actor: "http:POST:/skills/schedule:rollback" }
              );
            } catch { /* best effort */ }
          }
          if (existingJob) {
            const restored = runtime.cron.addJob({
              ...existingJob,
              replace: true
            });
            if (existingJob.lastRunAt !== null && existingJob.lastRunAt !== undefined) {
              runtime.cron.updateJob?.(restored.id, {
                lastRunAt: existingJob.lastRunAt
              });
            }
          } else {
            runtime.cron.removeJob?.(job.id);
          }
          throw error;
        }
        return sendJson(res, 200, { slug, jobId: job.id, dailyAt: body.dailyAt });
      }
      if (method === "GET" && pathname === "/proactive/preferences") {
        requireDefaultRequestProject(runtime, req, url, null, "Proactive preference access");
        if (!runtime.suggestionFeedback) return sendJson(res, 503, { error: "no feedback module" });
        return sendJson(res, 200, {
          preferences: runtime.suggestionFeedback.readPreferences(),
          stats: runtime.suggestionFeedback.computeStats(),
          summary: runtime.suggestionFeedback.preferenceSummary(),
          multipliers: runtime.suggestionFeedback.categoryMultipliers()
        });
      }
      if (method === "POST" && pathname === "/proactive/preferences/mute") {
        if (!runtime.suggestionFeedback) return sendJson(res, 503, { error: "no feedback module" });
        const body = await readJson(req).catch(() => ({}));
        requireDefaultRequestProject(
          runtime,
          req,
          url,
          body,
          "Proactive preference administration"
        );
        if (!body.category) return sendJson(res, 400, { error: "category required" });
        const muted = body.muted !== false;
        const prefs = runtime.suggestionFeedback.setMuted(body.category, muted);
        return sendJson(res, 200, { preferences: prefs });
      }
      if (method === "GET" && pathname.startsWith("/proactive/suggestions/") && pathname.endsWith("/outcome")) {
        requireDefaultRequestProject(runtime, req, url, null, "Proactive suggestion access");
        // Story 2: did the thing this suggestion proposed actually pan out?
        // Returns the suggestion record + a summary of every outcome that
        // carried sourceSuggestionId === id (skill runs, task completions).
        const id = decodeURIComponent(pathname.slice("/proactive/suggestions/".length, -"/outcome".length));
        const all = runtime.proactiveObserver?.list?.() ?? [];
        const suggestion = (Array.isArray(all) ? all : []).find((s) => s.id === id);
        if (!suggestion) return sendJson(res, 404, { error: "unknown suggestion" });
        return sendJson(res, 200, {
          suggestion,
          outcomes: runtime.outcomes?.bySuggestion?.(id) ?? [],
          summary: runtime.outcomes?.aggregateBySuggestion?.(id) ?? null
        });
      }
      if (method === "GET" && pathname === "/recap/daily") {
        requireDefaultRequestProject(runtime, req, url, null, "Legacy daily recap access");
        // Story 7: "what did I get done today" endpoint. Pulls the
        // structured recap; ?date=YYYY-MM-DD for past days.
        const { computeDailyRecap, renderDailyRecapMarkdown } = await import("./daily-recap.js");
        const dateParam = url.searchParams.get("date");
        const date = dateParam ? new Date(dateParam + "T12:00:00") : new Date();
        const recap = computeDailyRecap(runtime, { date });
        return sendJson(res, 200, {
          recap,
          markdown: renderDailyRecapMarkdown(recap)
        });
      }
      if (method === "GET" && pathname === "/plan/daily") {
        requireDefaultRequestProject(runtime, req, url, null, "Legacy daily plan access");
        // Morning planner: forward-looking "what should I do today."
        // Read-only: never queues actions as a side effect (the cron does
        // that). We attach the REAL status of any actions the cron already
        // queued for this day so the dashboard shows drafted vs pending.
        const { computeDailyPlan, renderDailyPlanMarkdown, listQueuedPlanActions } = await import("./daily-planner.js");
        const dateParam = url.searchParams.get("date");
        const date = dateParam ? new Date(dateParam + "T12:00:00") : new Date();
        const plan = await computeDailyPlan(runtime, { date });
        plan.queuedActions = listQueuedPlanActions(runtime, plan.dateISO);
        return sendJson(res, 200, { plan, markdown: renderDailyPlanMarkdown(plan) });
      }
      if (method === "GET" && pathname === "/observations/recent-context") {
        requireDefaultRequestProject(runtime, req, url, null, "Ambient observation access");
        if (!runtime.observations?.getRecentContext) return sendJson(res, 503, { error: "no observation store" });
        const minutes = Math.max(1, Math.min(60, Number(url.searchParams.get("minutes") ?? 10)));
        const ctx = await runtime.observations.getRecentContext({ minutes, maxChars: 1500, maxSnippets: 6 });
        return sendJson(res, 200, ctx);
      }
      if (method === "POST" && pathname === "/skills/mine") {
        // "Mine now" runs both miners so the user gets both activity-pattern
        // and chat-session candidates without having to know which is which.
        const body = await readJson(req).catch(() => ({}));
        const project = requireRequestProject(runtime, req, url, body);
        if (project.id !== "default") {
          return sendJson(res, 403, { error: "Skill mining administration is default-project only" });
        }
        try {
          const [patternResult, sessionResult] = await Promise.all([
            runtime.patternMiner.mine().catch((err) => ({ error: err.message })),
            runtime.sessionMiner.mine().catch((err) => ({ error: err.message }))
          ]);
          runtime.events?.emit?.("miner-result", { source: "pattern-miner", manual: true, ...patternResult });
          runtime.events?.emit?.("miner-result", { source: "session-miner", manual: true, ...sessionResult });
          return sendJson(res, 200, { pattern: patternResult, session: sessionResult });
        } catch (error) { return sendJson(res, 500, { error: error.message }); }
      }
      if (method === "POST" && pathname.match(/^\/skills\/suggested\/[^/]+\/accept$/)) {
        const id = decodeURIComponent(pathname.split("/")[3]);
        const body = await readJson(req).catch(() => ({}));
        const project = requireRequestProject(runtime, req, url, body);
        if (project.id !== "default") {
          return sendJson(res, 403, { error: "Suggested skill administration is default-project only" });
        }
        try { return sendJson(res, 200, runtime.patternMiner.accept(id)); }
        catch (error) { return sendJson(res, 400, { error: error.message }); }
      }
      if (method === "POST" && pathname.match(/^\/skills\/suggested\/[^/]+\/reject$/)) {
        const id = decodeURIComponent(pathname.split("/")[3]);
        const body = await readJson(req).catch(() => ({}));
        const project = requireRequestProject(runtime, req, url, body);
        if (project.id !== "default") {
          return sendJson(res, 403, { error: "Suggested skill administration is default-project only" });
        }
        const r = runtime.patternMiner.reject(id, body.reason);
        if (!r) return sendJson(res, 404, { error: "unknown candidate" });
        return sendJson(res, 200, r);
      }
      if (method === "POST" && pathname === "/skills/reload") {
        const project = requireRequestProject(runtime, req, url);
        if (project.id !== "default") {
          return sendJson(res, 403, { error: "Skill definition administration is default-project only" });
        }
        runtime.skills?.reload();
        return sendJson(
          res,
          200,
          (runtime.skills?.list() ?? [])
            .filter((skill) => projectAllows(project.activeSkills, skill.name))
        );
      }
      if (method === "POST" && pathname.match(/^\/skills\/[^/]+\/run$/)) {
        const name = decodeURIComponent(pathname.split("/")[2]);
        const body = await readJson(req);
        try {
          const project = requireRequestProject(runtime, req, url, body);
          assertProjectSkill(project, name);
          const result = await runtime.skills.run(
            name,
            { input: body.input ?? "", args: body.args ?? {} },
            projectToolContext(project, {
              ...(body.context ?? {}),
              channel: "local",
              from: "http:/skills/run"
            })
          );
          return sendJson(res, 200, result);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      // MARK: — Models & Providers
      //
      // The dashboard had no surface for "which model am I on and with whose
      // key" — provider switching only existed as a Discord slash command.
      // These routes back the Models tab. Keys are NEVER returned: only a
      // configured boolean and a masked preview, so a shared screen or a
      // screenshot can't leak a credential.
      if (method === "GET" && pathname === "/providers") {
        const project = requireRequestProject(runtime, req, url);
        if (project.id !== "default") {
          return sendJson(res, 403, { error: "Provider administration is default-project only" });
        }
        const active = activeProviderPreset();
        const provider = runtime.agentHost?.modelProvider ?? null;
        return sendJson(res, 200, {
          active,
          lane: String(process.env.OPENAGI_PROVIDER ?? "auto"),
          liveModel: provider?.model ?? null,
          presets: listProviderPresets().map((preset) => ({
            ...preset,
            configured: presetIsConfigured(preset.id),
            keyPreview: maskSecretPreview(process.env[preset.keyEnv]),
            active: preset.id === active
          }))
        });
      }
      // Store a vendor API key under its own env name. Kept separate from
      // activation so switching providers back and forth never loses a key.
      if (method === "POST" && pathname === "/providers/key") {
        const body = await readJson(req).catch(() => ({}));
        const project = requireRequestProject(runtime, req, url, body);
        if (project.id !== "default") {
          return sendJson(res, 403, { error: "Provider administration is default-project only" });
        }
        try {
          const preset = getProviderPreset(body.id);
          const value = String(body.apiKey ?? "").trim();
          if (!value) return sendJson(res, 400, { error: "apiKey is required" });
          saveEnv({
            dataDir: runtime.secrets?.dataDir,
            store: runtime.secrets,
            values: { [preset.keyEnv]: value },
            decidedBy: "dashboard:providers"
          });
          events.emit("providers", { op: "key-set", provider: preset.id });
          return sendJson(res, 200, {
            ok: true,
            id: preset.id,
            keyPreview: maskSecretPreview(process.env[preset.keyEnv])
          });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }
      // Point the live lane at a preset and rebuild the provider in place, so
      // the switch takes effect without a restart.
      if (method === "POST" && pathname === "/providers/activate") {
        const body = await readJson(req).catch(() => ({}));
        const project = requireRequestProject(runtime, req, url, body);
        if (project.id !== "default") {
          return sendJson(res, 403, { error: "Provider administration is default-project only" });
        }
        try {
          const preset = getProviderPreset(body.id);
          if (!presetIsConfigured(preset.id)) {
            return sendJson(res, 400, {
              error: `No API key stored for ${preset.label}. Save a key first.`
            });
          }
          const patch = presetActivationEnv(preset.id, { model: body.model });
          saveEnv({
            dataDir: runtime.secrets?.dataDir,
            store: runtime.secrets,
            values: patch,
            decidedBy: "dashboard:providers"
          });
          const { createModelProvider } = await import("./model-provider.js");
          const next = createModelProvider({
            preferred: preset.lane,
            budgetGuard: runtime.budget ?? null,
            secrets: runtime.secrets,
            dataDir: runtime.secrets?.dataDir
          });
          if (!next.isConfigured?.()) {
            return sendJson(res, 400, {
              error: `${preset.label} rebuilt without credentials; key may be invalid.`
            });
          }
          if (runtime.agentHost) runtime.agentHost.modelProvider = next;
          events.emit("providers", { op: "activated", provider: preset.id, model: next.model });
          return sendJson(res, 200, {
            ok: true,
            active: preset.id,
            model: next.model ?? null,
            lane: preset.lane
          });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      // MARK: — Gateway control (update / restart)
      //
      // Restart depends on a process supervisor (systemd Restart=always here):
      // we exit non-zero and let the supervisor bring us back. If nothing is
      // supervising this process, that would be a shutdown, not a restart — so
      // the route refuses unless a supervisor is declared.
      if (method === "GET" && pathname === "/gateway/status") {
        const project = requireRequestProject(runtime, req, url);
        if (project.id !== "default") {
          return sendJson(res, 403, { error: "Gateway administration is default-project only" });
        }
        let update = null;
        try {
          const { checkForUpdate } = await import("./self-update.js");
          update = await checkForUpdate();
        } catch (error) {
          update = { error: error.message };
        }
        return sendJson(res, 200, {
          pid: process.pid,
          uptimeSeconds: Math.round(process.uptime()),
          nodeVersion: process.version,
          supervised: gatewaySupervised(),
          update
        });
      }
      if (method === "POST" && pathname === "/gateway/update") {
        const body = await readJson(req).catch(() => ({}));
        const project = requireRequestProject(runtime, req, url, body);
        if (project.id !== "default") {
          return sendJson(res, 403, { error: "Gateway administration is default-project only" });
        }
        try {
          const { applyUpdate } = await import("./self-update.js");
          const result = await applyUpdate();
          events.emit("gateway", { op: "updated", ...result });
          return sendJson(res, 200, { ...result, restartRequired: true });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }
      if (method === "POST" && pathname === "/gateway/restart") {
        const body = await readJson(req).catch(() => ({}));
        const project = requireRequestProject(runtime, req, url, body);
        if (project.id !== "default") {
          return sendJson(res, 403, { error: "Gateway administration is default-project only" });
        }
        if (!gatewaySupervised()) {
          return sendJson(res, 409, {
            error: "No process supervisor detected. Exiting now would stop the agent, not restart it. Set OPENAGI_SUPERVISED=1 if a supervisor will bring it back."
          });
        }
        events.emit("gateway", { op: "restarting", pid: process.pid });
        // Respond BEFORE exiting, otherwise the caller sees a dropped socket
        // and can't tell a restart from a crash.
        sendJson(res, 200, { ok: true, restarting: true, pid: process.pid });
        setTimeout(() => process.exit(0), 250).unref?.();
        return undefined;
      }

      if (method === "GET" && pathname === "/mcp") {
        const project = requireRequestProject(runtime, req, url);
        const servers = runtime.mcp.listServers()
          .filter((server) => projectAllows(project.mcpGrants, server.name))
          .map((s) => ({
            ...s,
            connecting: runtime.mcp.isConnecting?.(s.name) ?? false,
            pendingAuthUrl: project.id === "default"
              ? pendingOauth.get(s.name)?.url ?? null
              : null
          }));
        return sendJson(res, 200, sanitizeForAudit(servers));
      }
      if (method === "GET" && pathname === "/mcp/tools") {
        const project = requireRequestProject(runtime, req, url);
        return sendJson(
          res,
          200,
          runtime.mcp.listTools()
            .filter((tool) => (
              projectAllows(project.mcpGrants, tool.server)
              && projectRequiredSecretsAllow(project, tool.requiredSecretRefs)
            ))
        );
      }
      if (method === "POST" && pathname.match(/^\/mcp\/connect\/[^/]+$/)) {
        const project = requireRequestProject(runtime, req, url);
        if (project.id !== "default") {
          return sendJson(res, 403, { error: "MCP connection administration is default-project only" });
        }
        const name = decodeURIComponent(pathname.split("/")[3]);
        assertProjectMcp(project, name);
        // Fire-and-forget so the OAuth dance doesn't block the HTTP response.
        // Dashboard polls /mcp and listens for SSE 'mcp' events to learn when
        // it's done (or if an OAuth URL needs to be opened).
        //
        // Always call connect(): the registry dedups in-flight attempts itself,
        // and a manual (interactive) connect made while a silent boot reconnect
        // is in flight must chain an interactive attempt after it — the silent
        // attempt can't open a browser and fails OAUTH_INTERACTIVE_REQUIRED,
        // which used to leave the Connect click doing nothing.
        runtime.mcp.connect(name)
          .then((status) => {
            pendingOauth.delete(name);
            events.emit("mcp", {
              op: "connected",
              name,
              projectId: project.id,
              tools: status?.tools ?? []
            });
          })
          .catch((error) => {
            events.emit("mcp", {
              op: "connect-error",
              name,
              projectId: project.id,
              error: error.message
            });
          });
        events.emit("mcp", { op: "connecting", name, projectId: project.id });
        return sendJson(res, 202, { name, status: "connecting" });
      }
      if (method === "POST" && pathname.match(/^\/mcp\/clear-auth\/[^/]+$/)) {
        const project = requireRequestProject(runtime, req, url);
        if (project.id !== "default") {
          return sendJson(res, 403, { error: "MCP auth administration is default-project only" });
        }
        const name = parseMcpServerName(pathname.split("/")[3]);
        if (!name) {
          return sendJson(res, 400, { error: "invalid MCP server name" });
        }
        pendingOauth.delete(name);
        // Wipe cached OAuth tokens so the next connect starts a fresh flow.
        try {
          const authDir = path.resolve(dataDir, "mcp", "auth");
          const authPath = path.resolve(authDir, `${name}.json`);
          if (path.dirname(authPath) !== authDir) {
            return sendJson(res, 400, { error: "invalid MCP server name" });
          }
          if (fsSync.existsSync(authDir) && fsSync.lstatSync(authDir).isSymbolicLink()) {
            return sendJson(res, 400, { error: "MCP auth storage is not a safe directory" });
          }
          if (fsSync.existsSync(authPath)) fsSync.unlinkSync(authPath);
        } catch { /* ignore */ }
        return sendJson(res, 200, { ok: true });
      }
      if (method === "POST" && pathname.match(/^\/mcp\/disconnect\/[^/]+$/)) {
        const project = requireRequestProject(runtime, req, url);
        if (project.id !== "default") {
          return sendJson(res, 403, { error: "MCP disconnection is default-project only" });
        }
        const name = decodeURIComponent(pathname.split("/")[3]);
        await runtime.mcp.disconnect(name);
        events.emit("mcp", { op: "disconnect", name });
        return sendJson(res, 200, { ok: true });
      }
      if (method === "POST" && pathname === "/mcp/connect-all") {
        const project = requireRequestProject(runtime, req, url);
        if (project.id !== "default") {
          return sendJson(res, 403, { error: "MCP connection administration is default-project only" });
        }
        const names = runtime.mcp.listServers()
          .map((server) => server.name)
          .filter((name) => projectAllows(project.mcpGrants, name));
        const results = await Promise.all(names.map(async (name) => {
          try {
            return await runtime.mcp.connect(name);
          } catch (error) {
            return { name, status: "error", error: error.message };
          }
        }));
        events.emit("mcp", { op: "connect-all", projectId: project.id, results });
        return sendJson(res, 200, results);
      }
      if (method === "POST" && pathname === "/mcp/call") {
        const body = await readJson(req);
        try {
          const project = requireRequestProject(runtime, req, url, body);
          assertProjectMcp(project, body.server);
          assertProjectMcpSecrets(runtime, project, body.server);
          const result = await runtime.mcp.callTool(body.server, body.tool, body.args ?? {});
          return sendJson(res, 200, result);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }
      if (method === "POST" && pathname === "/mcp/register") {
        const body = await readJson(req);
        try {
          const project = requireRequestProject(runtime, req, url, body);
          if (project.id !== "default") {
            return sendJson(res, 403, { error: "MCP registration is default-project only" });
          }
          const server = runtime.mcp.registerServer(body);
          return sendJson(res, 200, {
            name: server.name,
            transport: server.transport
          });
        } catch {
          // Registration errors can be derived from credential-bearing input.
          // Keep the HTTP rejection useful without reflecting any raw field.
          return sendJson(res, 400, { error: "MCP registration rejected" });
        }
      }

      if (method === "POST" && pathname === "/tick") {
        const body = await readJson(req);
        requireDefaultRequestProject(runtime, req, url, body, "Runtime scheduler control");
        const results = await runtime.tick(body.now ? new Date(body.now) : new Date());
        return sendJson(res, 200, { results });
      }

      return sendJson(res, 404, { error: "not-found" });
    } catch (error) {
      if (error?.code === "PROJECT_BOUNDARY_VIOLATION") {
        return sendJson(res, 403, {
          error: "project scope rejected",
          code: error.code
        });
      }
      if (error?.code === "PROJECT_REVISION_CONFLICT") {
        return sendJson(res, 409, {
          error: error.message,
          code: error.code
        });
      }
      // Log so we can diagnose 500s instead of swallowing them.
      const logLine = `[${new Date().toISOString()}] 500 ${req.method} ${req.url} — ${error.message}\n${error.stack ?? ""}\n`;
      try { process.stderr.write(logLine); } catch { /* ignore */ }
      return sendJson(res, 500, { error: error.message, route: req.url });
    }
  });

  const app = {
    runtime,
    channels,
    events,
    server,
    // Test seam: inject a fake agent host so /outreach/:id/reply and the
    // /channels/* routes can be exercised without a real model. The route
    // handlers close over the `channels` variable, so reassigning it here
    // takes effect immediately.
    __setChannels(c) { channels = c; },
    get __heartbeatHandle() { return heartbeatHandle ?? undefined; },
    async listen() {
      await runtime.terminalReconcilePromise;
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          channels?.start();
          if (tickerMs > 0) {
            tickerHandle = setInterval(() => {
              runtime.tick().catch(() => { /* swallow */ });
              try {
                runtime.outcomes?.resolveSweep({ agentStore: runtime.agentHost?.store ?? null });
              } catch { /* swallow */ }
            }, tickerMs);
          }
          const pairing = readNodeConfig(dataDir);
          if (pairing?.remote) {
            const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
            let heartbeatFailStreak = 0;
            const sendHeartbeat = async () => {
              try {
                const identity = readOrCreateIdentity(dataDir);
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 5000);
                try {
                  const res = await fetch(`${pairing.remote}/nodes/heartbeat`, {
                    method: "POST",
                    headers: {
                      "content-type": "application/json",
                      ...(pairing.token ? { authorization: `Bearer ${pairing.token}` } : {})
                    },
                    body: JSON.stringify({
                      nodeId: identity.nodeId, name: identity.name, role: "node",
                      url: options.publicUrl ?? process.env.OPENAGI_PUBLIC_URL ?? null,
                      version: PACKAGE_VERSION
                    }),
                    signal: ctrl.signal
                  });
                  if (!res.ok) throw new Error(`heartbeat rejected: ${res.status}`);
                } finally { clearTimeout(timer); }
                if (heartbeatFailStreak > 0) {
                  console.warn("[openagi] heartbeat to main recovered");
                }
                heartbeatFailStreak = 0;
              } catch (error) {
                heartbeatFailStreak += 1;
                if (heartbeatFailStreak === 1) {
                  console.warn(`[openagi] heartbeat to main failing (${error.message}) - will keep retrying`);
                }
              }
            };
            heartbeatHandle = setInterval(() => { sendHeartbeat().catch(() => {}); }, heartbeatIntervalMs);
          }
          const address = server.address();
          const actualPort = typeof address === "object" && address ? address.port : port;
          if (!gatewayStarted) {
            gatewayStarted = true;
            let platforms = ["local"];
            try {
              const status = channels?.status?.() ?? {};
              platforms = Object.entries(status)
                .filter(([name, value]) => name === "local" || value?.configured || value?.enabled)
                .map(([name]) => name);
            } catch { /* use local fallback */ }
            try {
              runtime.hooks?.notify?.("gateway:startup", { host, port: actualPort, platforms });
            } catch (error) {
              console.warn(`[hooks] gateway:startup failed open: ${error?.message ?? String(error)}`);
            }
          }
          resolve({ host, port: actualPort, url: `http://${host}:${actualPort}` });
        });
      });
    },
    async close() {
      for (const { type, listener } of ownedEventListeners.splice(0)) {
        if (typeof events.off === "function") events.off(type, listener);
        else events.removeListener?.(type, listener);
      }
      if (
        runtime.projects
        && hostedProjectChange
        && runtime.projects.onChange === hostedProjectChange
      ) {
        runtime.projects.onChange = previousProjectChange;
      }
      try { await runtime.agentHost?.endActiveHookSessions?.("gateway-close"); }
      catch (error) { console.warn(`[openagi] session review flush failed open: ${error?.message ?? String(error)}`); }
      try { runtime.hooks?.notify?.("gateway:shutdown", { host, port }); }
      catch (error) { console.warn(`[hooks] gateway:shutdown failed open: ${error?.message ?? String(error)}`); }
      try { await runtime.hooks?.flush?.(); }
      catch (error) { console.warn(`[hooks] shutdown flush failed open: ${error?.message ?? String(error)}`); }
      await new Promise((resolve, reject) => {
        if (tickerHandle) clearInterval(tickerHandle);
        if (heartbeatHandle) clearInterval(heartbeatHandle);
        for (const client of sseClients) {
          try { client.res.end(); } catch { /* ignore */ }
        }
        sseClients.clear();
        channels?.stop?.();
        runtime.tunnelWatcher?.stop?.();
        runtime.mcp?.disconnectAll?.().catch(() => {});
        server.close((error) => (error ? reject(error) : resolve()));
      });
      if (typeof runtime.close === "function") {
        await runtime.close();
      } else {
        await runtime.kanban?.close?.();
        await runtime.observations?.close?.();
        await runtime.sessionIndex?.close?.();
      }
    }
  };

  return app;
}

function handleSse(req, res, clients, projectId = "default") {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive"
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  const client = { res, projectId };
  clients.add(client);
  const heartbeat = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { /* dropped */ }
  }, 15000);
  req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(client);
  });
}

function sendHtml(res, status, value, cookies = []) {
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(value),
    "cache-control": "no-store"
  };
  if (cookies.length) headers["Set-Cookie"] = cookies;
  res.writeHead(status, headers);
  res.end(value);
}

function renderLoginPage(reason, next = "/") {
  // Sanitise the redirect target so an attacker can't bounce the user
  // off-site after sign-in.
  const safeNext = typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Cerberus · auth</title>
<style>body{font:14px/1.5 ui-sans-serif,system-ui;background:#030304;color:#ece9e7;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#0a0a0c;border:1px solid #2b1d1d;border-radius:10px;padding:24px;width:min(420px,90vw)}
h1{margin:0 0 4px;font-size:18px}p{color:#8f7d78;margin:6px 0 16px;font-size:13px}
input{width:100%;padding:9px 12px;background:#030304;color:#ece9e7;border:1px solid #2b1d1d;border-radius:6px;font:inherit;margin-bottom:10px}
button{background:#ff2b2b;color:#0a0203;border:0;padding:9px 14px;border-radius:6px;font-weight:700;cursor:pointer;width:100%}
.err{color:#f08080;margin-bottom:10px;font-size:12px}
.hint{color:#8f7d78;font-size:12px;margin-top:14px}
.hint code{background:#030304;padding:2px 5px;border-radius:3px;border:1px solid #2b1d1d}</style></head>
<body><form method="POST" action="/sign-in" id="loginForm" enctype="application/x-www-form-urlencoded">
<h1>Cerberus</h1><p>This daemon requires authentication.</p>
${reason ? `<div class="err">${escapeHtmlForLogin(reason)}</div>` : ""}
<input name="token" placeholder="Bearer token" autofocus required spellcheck="false" autocapitalize="off">
<input type="hidden" name="next" value="${escapeHtmlForLogin(safeNext)}">
<button type="submit">Sign in</button>
<div class="hint">Find your token in your data dir's <code>.env</code> as <code>OPENAGI_AUTH_TOKEN</code>.<br>If you're running the macOS app, click the menubar icon → <strong>Copy auth token</strong>.</div>
</form>
</body></html>`;
}

function escapeHtmlForLogin(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]);
}

// Never return a raw credential to a browser. Enough tail to recognize WHICH
// key is stored, not enough to use it. Short values are fully masked rather
// than partially revealed.
function maskSecretPreview(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (text.length <= 12) return "•".repeat(8);
  return `${"•".repeat(8)}${text.slice(-4)}`;
}

// Is something going to bring this process back if it exits?
//
// This MUST fail closed. Sniffing systemd's INVOCATION_ID/NOTIFY_SOCKET looks
// clever but is wrong: those are inherited by any child of a systemd-managed
// shell, so a hand-run `node bin/openagi.js` from a supervised terminal would
// report "supervised" and the Restart button would SHUT THE AGENT DOWN instead
// of restarting it. Nothing in the environment reliably distinguishes "I am
// the service" from "my grandparent was". So supervision is an explicit
// operator declaration: set OPENAGI_SUPERVISED=1 in the unit file that owns
// the Restart= policy. Default is no restart, which is the recoverable error.
function gatewaySupervised(env = process.env) {
  return String(env.OPENAGI_SUPERVISED ?? "").trim() === "1";
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function sendRunArtifact(res, artifact) {
  const data = Buffer.from(artifact.data);
  const extension = artifact.mediaType === "image/png"
    ? "png"
    : artifact.mediaType === "image/jpeg"
      ? "jpg"
      : artifact.mediaType === "image/webp"
        ? "webp"
        : artifact.mediaType === "application/json"
          ? "json"
          : artifact.mediaType === "application/zip" ? "zip" : "txt";
  const inline = artifact.mediaType.startsWith("image/")
    || artifact.mediaType === "application/json"
    || artifact.mediaType.startsWith("text/");
  res.writeHead(200, {
    "content-type": artifact.mediaType,
    "content-length": data.length,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${artifact.ref}.${extension}"`
  });
  res.end(data);
}

function sendSecretsJson(res, status, value) {
  res.setHeader("Cache-Control", "no-store");
  return sendJson(res, status, value);
}

function assertPlainHttpJobBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("job request must be a JSON object");
  }
}

function jsonUtf8Bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function normalizeHttpJobId(value) {
  const id = String(value ?? "").trim();
  if (!HTTP_JOB_ID_RE.test(id)) throw new TypeError("invalid job id");
  return id;
}

function normalizeHttpJobSession(value) {
  const sessionId = String(value ?? "").trim();
  if (!HTTP_JOB_SESSION_RE.test(sessionId)) {
    throw new TypeError("sessionId is required and must be printable ASCII");
  }
  return sessionId;
}

function assertHttpJobSessionProject(projects, project, sessionId) {
  if (typeof projects?.authorize === "function") {
    const authorized = projects.authorize(project.id, {
      includeArchived: false,
      sessionId
    });
    if (!authorized) throw new Error("project session is unavailable");
    return;
  }
  if (typeof projects?.assertSession === "function") {
    projects.assertSession(project.id, sessionId);
  }
}

function jobHttpContext(project, sessionId = null) {
  const allowedTools = Array.isArray(project.policy?.allowedTools)
    && !project.policy.allowedTools.includes("*")
    ? [...project.policy.allowedTools]
    : null;
  return {
    channel: "http",
    from: "http:jobs",
    agentId: "main",
    sessionId,
    __projectId: project.id,
    __projectRevision: project.revision ?? 1,
    __projectWorkspaceDir: project.workspaceRoot ?? null,
    __projectSecretRefs: [...(project.secretRefs ?? [])],
    __projectActiveSkills: [...(project.activeSkills ?? [])],
    __projectMcpGrants: [...(project.mcpGrants ?? [])],
    __projectHookIds: [...(project.hookIds ?? [])],
    __projectKanbanBoardId: project.kanbanBoardId ?? "default",
    __projectModelProfile: structuredClone(project.modelProfile ?? {}),
    __projectRoutingProfile: structuredClone(project.routingProfile ?? {}),
    __scrutinyPolicy: project.policy?.toolPolicy ?? "full",
    ...(allowedTools ? { __allowedTools: allowedTools } : {})
  };
}

function httpJobListFilters(searchParams) {
  const status = String(searchParams.get("status") ?? "").trim();
  if (status && !HTTP_JOB_STATUSES.has(status)) {
    throw new TypeError("invalid job status filter");
  }
  const kind = String(searchParams.get("kind") ?? "").trim();
  if (kind && !HTTP_JOB_KINDS.has(kind)) {
    throw new TypeError("invalid job kind filter");
  }
  return {
    limit: boundedHttpJobInteger(searchParams.get("limit"), {
      fallback: 50,
      min: 1,
      max: MAX_JOB_HTTP_LIST_LIMIT,
      field: "limit"
    }),
    ...(status ? { status } : {}),
    ...(kind ? { kind } : {})
  };
}

function boundedHttpJobInteger(value, {
  fallback,
  min,
  max,
  field
}) {
  if (value === null || value === undefined || value === "") return fallback;
  if (!/^\d+$/u.test(String(value))) {
    throw new TypeError(`${field} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`${field} must be a safe integer`);
  }
  return Math.max(min, Math.min(max, parsed));
}

function jobHttpStatusView(value, expectedProjectId = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value.job && typeof value.job === "object"
    ? value.job
    : value;
  const id = normalizeHttpJobId(source.id);
  const projectId = String(source.projectId ?? expectedProjectId ?? "").trim().toLowerCase();
  if (!projectId || (expectedProjectId && projectId !== expectedProjectId)) {
    const error = new Error("job is outside the requested project");
    error.code = "PROJECT_BOUNDARY_VIOLATION";
    throw error;
  }
  const error = source.error == null
    ? null
    : sanitizeForAudit(source.error);
  return {
    id,
    revision: safeJobInteger(source.revision),
    kind: safeJobString(source.kind, 32),
    target: safeJobString(source.target, 256),
    projectId,
    sessionId: safeJobString(source.sessionId, 512),
    status: safeJobString(source.status, 32),
    attempt: safeJobInteger(source.attempt),
    maxAttempts: safeJobInteger(source.maxAttempts),
    createdAt: safeJobTimestamp(source.createdAt),
    updatedAt: safeJobTimestamp(source.updatedAt),
    startedAt: safeJobTimestamp(source.startedAt),
    finishedAt: safeJobTimestamp(source.finishedAt),
    recoveredAt: safeJobTimestamp(source.recoveredAt),
    cancel: boundedJobJson(source.cancel, 2_000),
    toolOutputRef: safeJobString(source.toolOutputRef, 64),
    error: boundedJobJson(error, 2_000)
  };
}

function jobSseStatusView(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const source = value.job && typeof value.job === "object"
      ? value.job
      : value;
    const status = jobHttpStatusView(source, value.projectId ?? source.projectId);
    if (!status) return null;
    return {
      op: safeJobString(value.op, 32) ?? "status",
      id: status.id,
      projectId: status.projectId,
      status: status.status,
      revision: status.revision,
      updatedAt: status.updatedAt,
      finishedAt: status.finishedAt
    };
  } catch {
    return null;
  }
}

function boundedHttpJobCollection(value, expectedProjectId, maxChars) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : { output: value };
  const job = jobHttpStatusView(source.job ?? source, expectedProjectId);
  const output = Object.hasOwn(source, "output")
    ? source.output
    : Object.hasOwn(source, "result")
      ? source.result
      : null;
  const safeOutput = sanitizeForAudit(output);
  const encoded = JSON.stringify(safeOutput);
  if (typeof encoded !== "string" || encoded.length <= maxChars) {
    return { job, output: safeOutput ?? null };
  }
  return {
    job,
    output: {
      truncated: true,
      originalChars: encoded.length,
      preview: encoded.slice(0, maxChars)
    }
  };
}

function safeJobInteger(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function safeJobString(value, maxChars) {
  if (value === undefined || value === null) return null;
  return String(value).slice(0, maxChars);
}

function safeJobTimestamp(value) {
  const timestamp = safeJobString(value, 64);
  return timestamp && Number.isFinite(Date.parse(timestamp))
    ? timestamp
    : null;
}

function boundedJobJson(value, maxChars) {
  if (value === undefined || value === null) return null;
  const safe = sanitizeForAudit(value);
  const encoded = JSON.stringify(safe);
  if (typeof encoded !== "string") return null;
  if (encoded.length <= maxChars) return safe;
  return {
    truncated: true,
    preview: encoded.slice(0, maxChars)
  };
}

function safeJobHttpMessage(error, fallback) {
  const safe = sanitizeForAudit(error?.message ?? error ?? fallback);
  return String(safe || fallback).slice(0, 500);
}

function sendJobHttpError(res, error) {
  const code = String(error?.code ?? "");
  if ([
    "JOB_NOT_FOUND",
    "JOB_SESSION_BOUNDARY_VIOLATION",
    "PROJECT_BOUNDARY_VIOLATION"
  ].includes(code)) {
    return sendJson(res, 404, { error: "unknown job" });
  }
  if (code === "JOB_SECRET_VALUE_REJECTED") {
    return sendJson(res, 400, {
      error: "job request contains a credential value that cannot be persisted"
    });
  }
  if ([
    "JOB_ALREADY_EXISTS",
    "JOB_IDEMPOTENCY_CONFLICT",
    "JOB_NOT_READY",
    "JOB_RESOURCE_CONFLICT",
    "JOB_REVISION_CONFLICT",
    "JOB_TRANSITION_INVALID"
  ].includes(code)) {
    return sendJson(res, 409, {
      error: safeJobHttpMessage(error, "job state conflict"),
      code
    });
  }
  if (error instanceof RangeError) {
    return sendJson(res, 413, {
      error: safeJobHttpMessage(error, "job request exceeds a resource bound")
    });
  }
  if (error instanceof TypeError || code.startsWith("JOB_")) {
    return sendJson(res, 400, {
      error: safeJobHttpMessage(error, "job request rejected"),
      ...(code ? { code } : {})
    });
  }
  return sendJson(res, 500, { error: "job operation failed" });
}

function requireRequestProject(runtime, req, url, body = null) {
  const candidates = [
    req.headers["x-openagi-project"],
    url.searchParams.get("project"),
    body?.projectId
  ]
    .flat()
    .filter((value) => value !== undefined && value !== null && String(value).trim())
    .map((value) => String(value).trim().toLowerCase());
  const unique = [...new Set(candidates)];
  if (unique.length > 1) {
    const error = new Error("Conflicting project selections.");
    error.code = "PROJECT_BOUNDARY_VIOLATION";
    throw error;
  }
  const projectId = unique[0] ?? "default";
  if (
    typeof runtime.projects?.authorize !== "function"
    && typeof runtime.projects?.get !== "function"
  ) {
    if (projectId !== "default") {
      const error = new Error(`Unknown project: ${projectId}`);
      error.code = "PROJECT_BOUNDARY_VIOLATION";
      throw error;
    }
    return {
      id: "default",
      name: "Default",
      status: "active",
      revision: 1,
      workspaceRoot: runtime.agentHost?.workspaceDir ?? process.cwd(),
      memoryScope: "main",
      instructions: "",
      secretRefs: ["*"],
      activeSkills: ["*"],
      mcpGrants: ["*"],
      hookIds: ["*"],
      scheduleIds: [],
      artifactIds: [],
      recipeIds: [],
      kanbanBoardId: "default",
      policy: { toolPolicy: "full", allowedTools: ["*"] },
      modelProfile: {},
      routingProfile: {}
    };
  }
  const project = typeof runtime.projects.authorize === "function"
    ? runtime.projects.authorize(projectId, { includeArchived: false })
    : runtime.projects.get(projectId, { includeArchived: false });
  if (!project) {
    const error = new Error(`Unknown or archived project: ${projectId}`);
    error.code = "PROJECT_BOUNDARY_VIOLATION";
    throw error;
  }
  return project;
}

function requireDefaultRequestProject(runtime, req, url, body = null, operation = "This operation") {
  const project = requireRequestProject(runtime, req, url, body);
  if (project.id === "default") return project;
  const error = new Error(
    `${operation} is restricted to the default project control plane.`
  );
  error.code = "PROJECT_BOUNDARY_VIOLATION";
  throw error;
}

function sendArtifactHttpError(res, error) {
  const code = String(error?.code ?? "");
  if (
    code.includes("NOT_FOUND")
    || code.includes("BOUNDARY")
    || code === "PROJECT_BOUNDARY_VIOLATION"
  ) {
    return sendJson(res, 404, { error: "unknown artifact" });
  }
  if (
    code.includes("REVISION")
    || code.includes("STALE")
    || code.includes("CONFLICT")
  ) {
    return sendJson(res, 409, {
      error: "artifact revision conflict",
      code: code || "ARTIFACT_REVISION_CONFLICT"
    });
  }
  if (
    error instanceof TypeError
    || error instanceof RangeError
    || code.startsWith("ARTIFACT_INVALID")
  ) {
    return sendJson(res, 400, { error: error.message });
  }
  throw error;
}

function httpRecipeStatuses(value) {
  if (value == null || !String(value).trim()) return undefined;
  return String(value)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function sendRecipeHttpError(res, error) {
  const code = String(error?.code ?? "");
  if (
    code.includes("NOT_FOUND")
    || code.includes("BOUNDARY")
    || code === "PROJECT_BOUNDARY_VIOLATION"
  ) {
    return sendJson(res, 404, { error: "unknown recipe" });
  }
  if (
    code.includes("REVISION")
    || code.includes("STALE")
    || code.includes("CONFLICT")
  ) {
    return sendJson(res, 409, {
      error: "recipe revision conflict",
      code: code || "RECIPE_REVISION_CONFLICT"
    });
  }
  if (error instanceof RangeError) {
    return sendJson(res, 413, { error: error.message });
  }
  if (
    error instanceof TypeError
    || code.startsWith("RECIPE_")
  ) {
    return sendJson(res, 400, {
      error: error.message,
      ...(code ? { code } : {})
    });
  }
  throw error;
}

function sendCapabilityHttpError(res, error) {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? "capability administration failed");
  if (/^Unknown (?:profile|capability bundle|skill import)/u.test(message)) {
    return sendJson(res, 404, {
      error: "unknown capability resource",
      ...(code ? { code } : {})
    });
  }
  if (
    code.includes("REVISION")
    || code.includes("STALE")
    || code.includes("CONFLICT")
  ) {
    return sendJson(res, 409, {
      error: message,
      code: code || "CAPABILITY_REVISION_CONFLICT"
    });
  }
  if (
    code.includes("BOUNDARY")
    || code === "PROJECT_BOUNDARY_VIOLATION"
  ) {
    return sendJson(res, 403, {
      error: message,
      ...(code ? { code } : {})
    });
  }
  if (error instanceof RangeError) {
    return sendJson(res, 413, { error: message });
  }
  if (
    error instanceof TypeError
    || code.startsWith("CAPABILITY_")
    || code.startsWith("SKILL_IMPORT_")
  ) {
    return sendJson(res, 400, {
      error: message,
      ...(code ? { code } : {})
    });
  }
  throw error;
}

function projectSkillScheduleId(projectId, skillSlug) {
  if (projectId === "default") return `skill-cron-${skillSlug}`;
  const projectKey = createHash("sha256")
    .update(`project-skill-schedule\0${projectId}\0${skillSlug}`)
    .digest("hex")
    .slice(0, 24);
  return `skill-cron-${skillSlug}-${projectKey}`;
}

function assertHostedProjectStoreAvailable(runtime, required) {
  if (!required || typeof runtime.projects?.projectForSession === "function") {
    return;
  }
  const error = new Error(
    "Session project bindings are unavailable; session access is disabled."
  );
  error.code = "PROJECT_BOUNDARY_VIOLATION";
  throw error;
}

function assertHostedSessionProject(
  runtime,
  store,
  sessionId,
  expectedProject,
  { projectStoreRequired = false } = {}
) {
  assertHostedProjectStoreAvailable(runtime, projectStoreRequired);
  const sessionExists = typeof store?.hasSession === "function"
    ? store.hasSession(sessionId)
    : typeof store?.listSessions === "function"
      ? store.listSessions().some((session) => session?.id === sessionId)
      : false;
  if (!sessionExists) {
    const error = new Error(`Unknown session '${sessionId}'.`);
    error.code = "SESSION_NOT_FOUND";
    throw error;
  }
  if (typeof runtime.projects?.projectForSession === "function") {
    const boundProject = runtime.projects.projectForSession(sessionId);
    if (!boundProject || boundProject.id !== expectedProject.id) {
      const error = new Error(`Session '${sessionId}' is outside the current project.`);
      error.code = "PROJECT_BOUNDARY_VIOLATION";
      throw error;
    }
  }
  if (typeof runtime.projects?.assertSession === "function") {
    runtime.projects.assertSession(expectedProject.id, sessionId);
  } else if (expectedProject.id !== "default") {
    const error = new Error("Nondefault session scope requires a project store.");
    error.code = "PROJECT_BOUNDARY_VIOLATION";
    throw error;
  }

  const session = store?.getSession?.(sessionId) ?? null;
  const durableProjectId = durableSessionProjectId(session);
  if (
    durableProjectId === null
    && expectedProject.id !== "default"
    && Array.isArray(session?.messages)
    && session.messages.length > 0
  ) {
    const error = new Error(
      `Session '${sessionId}' is missing its durable project binding.`
    );
    error.code = "PROJECT_BOUNDARY_VIOLATION";
    throw error;
  }
  if (durableProjectId !== null && durableProjectId !== expectedProject.id) {
    const error = new Error(
      `Session '${sessionId}' has an inconsistent durable project binding.`
    );
    error.code = "PROJECT_BOUNDARY_VIOLATION";
    throw error;
  }
  return true;
}

function durableSessionProjectId(session) {
  if (!session || typeof session !== "object") return null;
  const ids = new Set();
  const candidates = [
    session.projectId,
    session.metadata?.projectId,
    ...(Array.isArray(session.messages)
      ? session.messages.map((message) => message?.metadata?.projectId)
      : [])
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === "") continue;
    if (typeof candidate !== "string") {
      const error = new Error("Session contains an invalid durable project binding.");
      error.code = "PROJECT_BOUNDARY_VIOLATION";
      throw error;
    }
    ids.add(candidate.trim().toLowerCase());
  }
  if (ids.size > 1) {
    const error = new Error("Session contains conflicting durable project bindings.");
    error.code = "PROJECT_BOUNDARY_VIOLATION";
    throw error;
  }
  return ids.values().next().value ?? null;
}

function eventProject(data) {
  const value = data?.projectId
    ?? data?.project?.id
    ?? data?.draft?.projectId
    ?? data?.job?.input?.projectId
    ?? data?.input?.projectId
    ?? null;
  return value == null ? null : String(value);
}

function projectMemorySnapshot(memory, project) {
  const snapshot = memory?.snapshot?.() ?? { short: [], medium: [], long: [] };
  const prefix = `project:${project.id}`;
  const visible = (item) => project.id === "default"
    ? !String(item?.scope ?? "main").startsWith("project:")
    : (
        String(item?.scope ?? "") === prefix
        || String(item?.scope ?? "").startsWith(`${prefix}:`)
      );
  return Object.fromEntries(
    Object.entries(snapshot).map(([tier, items]) => [
      tier,
      Array.isArray(items) ? items.filter(visible) : []
    ])
  );
}

function assertProjectSkill(project, skillName) {
  if (projectAllows(project.activeSkills, skillName)) return;
  const error = new Error(`Skill '${skillName}' is not active in project '${project.id}'.`);
  error.code = "PROJECT_BOUNDARY_VIOLATION";
  throw error;
}

function assertProjectMcp(project, serverName) {
  if (projectAllows(project.mcpGrants, serverName)) return;
  const error = new Error(`MCP server '${serverName}' is not granted to project '${project.id}'.`);
  error.code = "PROJECT_BOUNDARY_VIOLATION";
  throw error;
}

function projectRequiredSecretsAllow(project, requiredSecretRefs) {
  if (!Array.isArray(requiredSecretRefs) || requiredSecretRefs.length === 0) return true;
  return requiredSecretRefs.every((name) => projectAllows(project.secretRefs, name));
}

function assertProjectMcpSecrets(runtime, project, serverName) {
  const required = runtime.mcp?.requiredSecretRefs?.(serverName) ?? [];
  if (projectRequiredSecretsAllow(project, required)) return;
  const denied = required.find((name) => !projectAllows(project.secretRefs, name));
  const error = new Error(
    `MCP server '${serverName}' requires secret reference '${denied}' which is not granted to project '${project.id}'.`
  );
  error.code = "PROJECT_BOUNDARY_VIOLATION";
  throw error;
}

function projectToolContext(project, context = {}) {
  return {
    ...context,
    projectId: project.id,
    __projectId: project.id,
    __projectRevision: project.revision,
    __projectWorkspaceDir: project.workspaceRoot,
    __projectSecretRefs: [...project.secretRefs],
    __projectActiveSkills: [...project.activeSkills],
    __projectMcpGrants: [...project.mcpGrants],
    __projectHookIds: [...project.hookIds],
    __projectKanbanBoardId: project.kanbanBoardId,
    __memoryScope: projectMemoryScope(project)
  };
}

async function requireProjectKanbanTask(runtime, project, taskId) {
  const task = await runtime.kanban?.getTask?.(taskId);
  if (!task || task.board !== project.kanbanBoardId) {
    const error = new Error(`Unknown Kanban task: ${taskId}`);
    error.code = "PROJECT_BOUNDARY_VIOLATION";
    throw error;
  }
  return task;
}

function parseMcpServerName(encoded) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(encoded ?? ""));
  } catch {
    return null;
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(decoded)
    || /[ .]$/.test(decoded)
  ) {
    return null;
  }
  const stem = decoded.split(".")[0].toUpperCase();
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)
    ? null
    : decoded;
}

function publicSecretMetadata(entry, fallbackName = "") {
  const name = fallbackName
    ? String(fallbackName)
    : (typeof entry?.name === "string" ? entry.name : "");
  const last4 = typeof entry?.last4 === "string" && entry.last4.length <= 4
    ? entry.last4
    : null;
  return {
    name,
    last4,
    preview: last4 ? `****${last4}` : "****"
  };
}

function publicSecretError(error) {
  if (error instanceof TypeError && /^Unknown secret name:/.test(error.message)) {
    return "unknown secret name";
  }
  return "secret operation rejected";
}

function configuredSecretNames(store, { decidedBy } = {}) {
  if (!store) return null;
  try {
    if (typeof store.listSecretNames === "function") {
      return new Set(store.listSecretNames({ decidedBy }));
    }
    if (typeof store.listSecrets === "function") {
      return new Set(
        store.listSecrets({ decidedBy })
          .map((entry) => entry?.name)
          .filter((name) => typeof name === "string")
      );
    }
  } catch {
    return new Set();
  }
  // A store exists, so process.env is not an acceptable fallback source.
  return new Set();
}

function isStoredSecretConfigured(store, name, { decidedBy } = {}) {
  const names = configuredSecretNames(store, { decidedBy });
  if (names !== null) return names.has(name);
  return Boolean(process.env[name]);
}

// Map an outreach action to the real action on the underlying source. Throws
// on a failed delegation so the route can mark the item status:"error".
async function applyOutreachAction(runtime, item, action, note, projectId = "default") {
  if (action === "dismiss") return;
  if (action === "up" || action === "down") return applyOutreachFeedback(runtime, item, action, note);
  const ref = item.sourceRef ?? {};
  switch (ref.kind) {
    case "draft":
      if (action === "approve") {
        if (!runtime.drafts?.approve(ref.id, { projectId })) {
          throw new Error("draft not approvable");
        }
        return;
      }
      if (action === "edit") return;
      throw new Error(`unsupported draft action: ${action}`);
    case "task":
      assertDefaultOutreachSource(projectId, "task");
      // TaskStore has no dedicated cancel(); update(id,{status:"cancelled"})
      // is the canonical cancel path (returns the task, or null if unknown).
      if (action === "close") { if (!runtime.tasks?.update(ref.id, { status: "cancelled" })) throw new Error("task not cancellable"); return; }
      if (action === "keep" || action === "snooze") return;
      throw new Error(`unsupported task action: ${action}`);
    case "pending-action":
      if (action === "do") {
        const a = runtime.pendingActions?.get(ref.id, { projectId });
        if (!a) {
          throw new Error("pending action gone");
        }
        if (a.status !== "pending") return; // already decided elsewhere — don't re-run the side-effecting tool
        const r = await approvePendingAction(runtime, ref.id, {
          decidedBy: "user",
          approvedVia: "outreach",
          projectId
        });
        if (!r.ok) throw new Error(r.error ?? "tool failed");
        return;
      }
      throw new Error(`unsupported pending-action action: ${action}`);
    case "suggestion":
      if (action === "accept") return;
      throw new Error(`unsupported suggestion action: ${action}`);
    case "clarification":
      assertDefaultOutreachSource(projectId, "clarification");
      if (!runtime.clarifications?.answer) throw new Error("no clarification store");
      if (!runtime.clarifications.answer(ref.id, action)) throw new Error("clarification not answerable");
      return;
    case "skill-candidate": {
      assertDefaultOutreachSource(projectId, "skill-candidate");
      if (action !== "accept") throw new Error(`unsupported skill-candidate action: ${action}`);
      const { findSuggestion, resolveSuggestion } = await import("./suggestion-feed.js");
      const candidate = findSuggestion(runtime, ref.id);
      if (!candidate) throw new Error("skill candidate gone");
      if (candidate.status === "accepted") return;
      const { createSkillFromCandidate } = await import("./skill-materialize.js");
      createSkillFromCandidate({ runtime, candidate });
      resolveSuggestion(runtime, ref.id, "accepted");
      runtime.skills?.reload?.();
      runtime.events?.emit?.("suggestion-resolved", { id: ref.id, status: "accepted", category: "skill" });
      return;
    }
    default:
      // No handler for this item kind — do NOT silently succeed. A silent
      // return here is indistinguishable from a real successful action in
      // the outreach history (the caller marks the item "acted" either way).
      throw new Error(`no handler for outreach item kind "${ref.kind}" with action "${action}"`);
  }
}

function assertDefaultOutreachSource(projectId, kind) {
  if (projectId === "default") return;
  throw new Error(`${kind} outreach actions are default-project only`);
}

async function applyOutreachFeedback(runtime, item, verdict, note = null) {
  const score = verdict === "up" ? 0.9 : 0.15;
  const resolutionNote = note ?? `outreach thumbs-${verdict} on "${item.title}"`;
  let resolved = null;
  if (item.outcomeId && runtime.outcomes?.resolve) {
    resolved = runtime.outcomes.resolve(item.outcomeId, score, "explicit-rating", resolutionNote);
  }
  if (!resolved && runtime.outcomes?.record) {
    const fresh = runtime.outcomes.record({
      kind: "explicit-feedback",
      refId: item.id,
      metadata: { outreachType: item.type, sourceRef: item.sourceRef ?? null, verdict }
    });
    resolved = runtime.outcomes.resolve(fresh.id, score, "explicit-rating", resolutionNote);
  }
  if (item.sourceRef?.kind === "suggestion" && runtime.proactiveObserver?.resolve) {
    runtime.proactiveObserver.resolve(item.sourceRef.id, verdict === "up" ? "accepted" : "rejected", resolutionNote);
  }
  return resolved;
}

// Cap request bodies so an exposed/tunneled daemon can't be OOM'd by an
// unbounded POST (Tier-1 hardening). 5 MB is far above any legit payload.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const params = new URLSearchParams(text);
      resolve(Object.fromEntries(params.entries()));
    });
    req.on("error", reject);
  });
}

/* ─── Cerberus brand assets (inline SVG, Node-safe string builders) ────────
   The three-wolf mark + a 19-glyph HUD icon set, drawn as line-art so they
   inherit the emissive red via currentColor / var(--accent). Everything is a
   plain string so it renders identically server-side (renderApp) and inline. */

function cerbMarkSVG(size, opts = {}) {
  const W = 64;
  const stroke = opts.stroke || "currentColor";
  const sw = opts.strokeWidth || 2;
  const bg = opts.bg || "var(--bg, #050506)";
  const mir = (pts) => pts.map(([x, y]) => [W - x, y]);
  const poly = (pts, extra = "") =>
    '<path d="' + pts.map((p, i) => (i ? "L" : "M") + p[0] + " " + p[1]).join(" ") + ' Z" ' + extra + "/>";
  const line = (pts) =>
    '<path d="' + pts.map((p, i) => (i ? "L" : "M") + p[0] + " " + p[1]).join(" ") + '" />';
  // Side profile wolf head (left, facing out): long tapered muzzle, ear on a
  // rounded cranium, jaw hook + neck gap, eye under a brow, mouth line.
  const sideHead = [[0,20],[10,15],[11,14],[13,6],[16,12],[20,14],[19,20],[18,25],[11,27],[5,25],[0,23]];
  const sideEye = [[10,19],[13,18]];
  const sideBrow = [[9,16],[13,15]];
  const sideMouth = [[2,22],[8,23]];
  // Center frontal wolf head (bg fill sits it in front of the side heads).
  const center = [[21,4],[26,13],[32,11],[38,13],[43,4],[44,15],[42,25],[37,33],[32,40],[27,33],[22,25],[20,15]];
  const brow = [[27,17],[32,19],[37,17]];
  const eyeL = [[26,22],[29,24]];
  const eyeR = [[38,22],[35,24]];
  const nose = [[30,30],[34,30],[32,33]];
  let inner = "";
  inner += "<g>" + poly(sideHead, 'fill="' + bg + '"') + line(sideEye) + line(sideBrow) + line(sideMouth) + "</g>";
  inner += "<g>" + poly(mir(sideHead), 'fill="' + bg + '"') + line(mir(sideEye)) + line(mir(sideBrow)) + line(mir(sideMouth)) + "</g>";
  inner += poly(center, 'fill="' + bg + '"');
  inner += line(brow) + line(eyeL) + line(eyeR) + poly(nose);
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="' + size +
    '" height="' + size + '" fill="none" stroke="' + stroke + '" stroke-width="' + sw +
    '" stroke-linejoin="miter" stroke-linecap="square" aria-hidden="true">' + inner + "</svg>";
}

/* 20 nav glyphs + setup — minimal line-art HUD icons (24 grid, currentColor). */
const HUD_ICONS = {
  chat: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  tasks: '<path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/>',
  suggestions: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.4 1 2.3h6c0-.9.4-1.8 1-2.3A7 7 0 0 0 12 2z"/>',
  memory: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  integrations: '<path d="M9 2v6"/><path d="M15 2v6"/><path d="M7 8h10v3a5 5 0 0 1-10 0z"/><path d="M12 16v6"/>',
  projects: '<path d="M3 7.5 A1.5 1.5 0 0 1 4.5 6h4l2 2.5h9A1.5 1.5 0 0 1 21 10v7.5A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/><path d="M3 11h18"/>',
  mcp: '<path d="M12 2l8 4.5v9L12 20l-8-4.5v-9z"/><path d="M12 11l8-4.5M12 11L4 6.5M12 11v9"/>',
  models: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M17.5 14v7M14 17.5h7"/>',
  skills: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.7 2.1 2.1.7-2.1.7L19 20.6l-.7-2.1-2.1-.7 2.1-.7z"/>',
  cron: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  kanban: '<path d="M4 4h4v16H4z"/><path d="M10 4h4v12h-4z"/><path d="M16 4h4v8h-4z"/>',
  channels: '<circle cx="12" cy="9" r="2"/><path d="M12 11v11"/><path d="M7.8 13.2a6 6 0 0 1 0-8.4"/><path d="M16.2 13.2a6 6 0 0 0 0-8.4"/>',
  agents: '<rect x="5" y="8" width="14" height="12" rx="2"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><path d="M9 13h.01"/><path d="M15 13h.01"/><path d="M9 17h6"/>',
  nodes: '<circle cx="5" cy="12" r="2.5"/><circle cx="19" cy="5" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M7.3 10.8l9.4-4.6M7.3 13.2l9.4 4.6"/>',
  today: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>',
  activity: '<path d="M22 12h-4l-3 8L9 4l-3 8H2"/>',
  "computer-use": '<path d="M4 4l7 17 2.5-7L21 11.5z"/>',
  budget: '<rect x="2" y="6" width="20" height="13" rx="2"/><path d="M2 10h20"/><path d="M6 15h4"/>',
  outcomes: '<circle cx="12" cy="9" r="6"/><path d="M8.5 14L7 22l5-3 5 3-1.5-8"/>',
  health: '<path d="M20.8 6.6a5.5 5.5 0 0 0-8.8-1.6A5.5 5.5 0 0 0 3.2 6.6c-1.6 3.7 2.2 7.4 8.8 12.4 6.6-5 10.4-8.7 8.8-12.4z"/>',
  scrutiny: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  ops: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>',
  setup: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>',
  update: '<path d="M12 3v10"/><path d="M8 9l4 4 4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  restart: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 3v5h-5"/>',
};
function hudIcon(name) {
  const body = HUD_ICONS[name] || HUD_ICONS.chat;
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + "</svg>";
}

/* Inline SVG favicon from the mark (avoids a favicon.ico 404 + brands the tab). */
function cerbFavicon() {
  const svg = cerbMarkSVG(64, { stroke: "#ff2b2b", bg: "#030304" });
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

function renderApp() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cerberus</title>
  <link rel="icon" href="${cerbFavicon()}">
  <!-- Theme typefaces — loaded once, referenced by name from each theme's
       --font-display / --font-body / --font-mono stacks. The stacks always
       end in a system fallback, so the UI never breaks offline. -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;800&family=Rajdhani:wght@400;500;600;700&family=Share+Tech+Mono&family=Chakra+Petch:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: light dark;
      /* Legacy tokens — kept so existing inline-styled components don't
         drift visually while we migrate them to the shadcn-vocab layer. */
      --bg: #030304;
      --panel: #0a0a0c;
      --panel-2: #161010;
      --text: #ece9e7;
      --muted: #8f7d78;
      --line: #2b1d1d;
      --accent: #ff2b2b;
      --accent-soft: rgba(255, 43, 43, 0.10);
      --user: #1a0d0e;
      --assistant: #161010;
      --warn: #f0b454;
      --err: #ff5a4a;

      /* ─── Cerberus / TRON:ARES extension tokens ─────────────────────────
         Emissive red, chamfered HUD chrome. Red is glow + edge-light,
         never large fills — keep the canvas near-black. */
      --accent-glow: #ff5a4a;
      --accent-deep: #7a0b0b;
      --accent-line: #3a0f12;
      --line-hot: #3a0f12;
      --holo: #ff2b2b;
      --holo-dim: rgba(255, 43, 43, 0.35);
      --chamfer: 10px;
      --font-display: "Bahnschrift", "DIN Alternate", "Franklin Gothic Medium", "Arial Narrow", "Segoe UI", sans-serif;
      --font-body: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      --font-mono: "Cascadia Code", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      --glow-sm: 0 0 6px rgba(255, 43, 43, 0.45);
      --glow-md: 0 0 14px rgba(255, 43, 43, 0.35);

      /* shadcn-vocab tokens. We've adopted the same names openclaw uses
         (which mirror shadcn) so future tabs / components have a stable
         palette + spacing scale to lean on. New work should reach for
         these first; legacy components keep using the originals above
         until they're migrated. */
      --background: var(--bg);
      --foreground: var(--text);
      --card: var(--panel);
      --card-foreground: var(--text);
      --popover: #161010;
      --popover-foreground: var(--text);
      --primary: var(--accent);
      --primary-foreground: #0a0203;
      --secondary: var(--panel-2);
      --secondary-foreground: var(--text);
      --muted-bg: var(--panel-2);
      --muted-foreground: var(--muted);
      --accent-bg: var(--accent-soft);
      --accent-foreground: var(--accent);
      --destructive: #b3463a;
      --destructive-foreground: #ffd9d4;
      --border: var(--line);
      --input: var(--panel-2);
      --ring: rgba(255, 43, 43, 0.45);

      /* Spacing scale (4px grid) and radius / typography — used by
         the primitive classes below. */
      --space-1: 4px;
      --space-2: 8px;
      --space-3: 12px;
      --space-4: 16px;
      --space-5: 24px;
      --space-6: 32px;
      --radius-sm: 2px;
      --radius: 2px;
      --radius-lg: 4px;
      --font-size-xs: 11px;
      --font-size-sm: 12px;
      --font-size-base: 14px;
      --font-size-lg: 16px;
      --shadow-sm: 0 1px 2px rgba(0,0,0,.5);
      --shadow: 0 4px 16px rgba(0,0,0,.55);
    }

    /* ─── Theme skins ──────────────────────────────────────────────────────
       Each theme overrides the token layer above via html[data-theme].
       "ares" (the default) is simply :root — no override needed, so the
       shipped look is untouched. New skins only redefine tokens; they never
       touch component rules, so they can't drift from the base layout.
       Type pairings travel with the theme: each skin carries its own
       --font-display / --font-body / --font-mono stacks (Google Fonts with
       system fallbacks, so nothing breaks offline). */
    html[data-theme="cyberpunk"] {
      /* Neon duotone — hot magenta primary over a deep indigo-black ground,
         with cyan as the live/success accent. Deliberately NOT the default
         "black + one neon" cliché: two saturated hues + warm text keep it
         readable and give the rail real depth. */
      --bg: #06060f;
      --panel: #0b0b1c;
      --panel-2: #131329;
      --text: #eae6f7;
      --muted: #8b87b8;
      --line: #23234a;
      --accent: #ff2d95;
      --accent-soft: rgba(255, 45, 149, 0.10);
      --user: #190d22;
      --assistant: #12102a;
      --warn: #ffb454;
      --err: #ff4d6d;
      --accent-glow: #ff5cb1;
      --accent-deep: #7a0b4a;
      --accent-line: #3a0f2e;
      --line-hot: #3a0f2e;
      --holo: #2de2ff;
      --holo-dim: rgba(45, 226, 255, 0.35);
      --glow-sm: 0 0 6px rgba(255, 45, 149, 0.5);
      --glow-md: 0 0 14px rgba(255, 45, 149, 0.38);
      --primary: var(--accent);
      --primary-foreground: #14020c;
      --popover: #131329;
      --ring: rgba(255, 45, 149, 0.5);
      --destructive: #ff4d6d;
      --destructive-foreground: #ffe3ea;
      /* Type pairing: Orbitron (geometric sci-fi display) over Rajdhani
         (angular, legible body) with Share Tech Mono for data. */
      --font-display: "Orbitron", "Bahnschrift", "DIN Alternate", "Segoe UI", sans-serif;
      --font-body: "Rajdhani", "Segoe UI", ui-sans-serif, system-ui, sans-serif;
      --font-mono: "Share Tech Mono", "Cascadia Code", ui-monospace, Menlo, Consolas, monospace;
    }
    html[data-theme="cyberpunk"] .railnav nav button.active {
      /* Active tab rides the cyan edge so the duotone reads across the rail. */
      box-shadow: inset 2px 0 0 var(--holo);
      text-shadow: 0 0 8px var(--holo-dim);
    }
    html[data-theme="cyberpunk"] .railnav nav button.active::after {
      background: linear-gradient(180deg, transparent 0%, var(--holo) 50%, transparent 100%);
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 var(--font-body);
      height: 100vh;
      overflow: hidden;
    }
    /* ─── Hermes-style shell: fixed left nav rail + content column ─────── */
    :root { --rail-w: 232px; }
    /* Ambient phase-transition background — fixed full-viewport canvas behind
       the app shell. pointer-events:none so it never intercepts interaction;
       z-index 0 with .app raised above it. */
    #cerbBg {
      position: fixed; inset: 0; z-index: 0;
      width: 100vw; height: 100vh;
      pointer-events: none;
      background: var(--bg);
    }
    .app { position: relative; z-index: 1; display: grid; grid-template-columns: var(--rail-w) 1fr; height: 100vh; }

    /* Left navigation rail — brand at top, grouped vertical nav, setup pinned
       to the bottom. Mirrors the Hermes dashboard's persistent left sidebar. */
    .railnav {
      background: var(--panel);
      border-right: 1px solid var(--line);
      display: flex; flex-direction: column; min-height: 0;
      padding: 0;
    }
    .railnav .brand {
      display: flex; align-items: center; gap: 10px;
      height: 56px; padding: 0 18px; flex: 0 0 auto;
      border-bottom: 1px solid var(--line);
    }
    .railnav .brand-mark {
      width: 30px; height: 30px; flex: 0 0 auto;
      display: grid; place-items: center;
      color: var(--accent);
      filter: drop-shadow(0 0 6px rgba(255,43,43,.4));
    }
    .railnav .brand-mark svg { display: block; }
    .railnav .brand-name { font-size: 15px; font-weight: 600; letter-spacing: 0.18em; color: var(--text); text-transform: uppercase; }
    .railnav nav {
      display: flex; flex-direction: column; gap: 1px;
      padding: 10px 10px 16px; overflow-y: auto; flex: 1 1 auto; min-height: 0;
    }
    .nav-group-label {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.09em;
      color: var(--muted-foreground); padding: 14px 10px 4px; user-select: none;
    }
    .nav-group-label:first-child { padding-top: 4px; }
    .railnav nav button {
      display: flex; align-items: center; gap: 9px;
      text-align: left; width: 100%;
      background: transparent; border: 1px solid transparent; color: var(--muted);
      padding: 7px 10px; border-radius: var(--radius-sm); cursor: pointer;
      font-size: 13px; font-family: inherit; line-height: 1.2;
      transition: background 0.12s, color 0.12s;
    }
    .railnav nav button .nav-ico { width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; opacity: 0.85; }
    .railnav nav button .nav-ico svg { display: block; }
    .railnav nav button:hover { color: var(--text); background: var(--muted-bg); }
    .railnav nav button.active {
      position: relative;
      color: var(--accent); background: var(--accent-soft);
      border-color: transparent; font-weight: 600;
      box-shadow: inset 2px 0 0 var(--accent);
      text-shadow: 0 0 8px rgba(255,43,43,.5);
    }
    .railnav nav button.active .nav-ico { opacity: 1; }
    /* Travelling light-trail down the active tab's left edge. */
    .railnav nav button.active::after {
      content: ""; position: absolute; left: 0; top: 0; width: 2px; height: 100%;
      background: linear-gradient(180deg, transparent 0%, var(--accent-glow) 50%, transparent 100%);
      background-size: 100% 200%;
      animation: cerb-trail 2.4s ease-in-out infinite;
      pointer-events: none;
    }
    @keyframes cerb-trail {
      0%   { background-position: 0% 200%; opacity: 0; }
      30%  { opacity: 1; }
      100% { background-position: 0% -100%; opacity: 0; }
    }
    .railnav .rail-footer { flex: 0 0 auto; border-top: 1px solid var(--line); padding: 10px; }
    #setupBtn {
      display: flex; align-items: center; gap: 9px; width: 100%;
      background: transparent; border: 1px solid var(--line); color: var(--muted);
      padding: 8px 10px; border-radius: var(--radius-sm); cursor: pointer;
      font-size: 13px; font-family: inherit;
    }
    #setupBtn:hover { color: var(--text); border-color: var(--accent); }

    /* Theme switcher — pinned in the rail footer above Setup. Two swatch
       buttons; the active one carries the accent ring + glow. The label row
       collapses with the rest of the rail text on narrow viewports. */
    #themeSwitch { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
    #themeSwitch .theme-label {
      font-family: var(--font-mono); font-size: 9px; letter-spacing: 0.22em;
      text-transform: uppercase; color: var(--muted); margin-right: auto;
    }
    .theme-btn {
      width: 22px; height: 22px; border-radius: var(--radius-sm); cursor: pointer;
      border: 1px solid var(--line); padding: 0; flex: 0 0 auto;
      transition: transform .15s ease, box-shadow .15s ease, border-color .15s ease;
    }
    .theme-btn:hover { transform: translateY(-1px); border-color: var(--muted); }
    .theme-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .theme-btn.active { border-color: var(--accent); box-shadow: 0 0 8px var(--glow-sm), inset 0 0 0 1px var(--accent); }
    .theme-btn[data-theme="ares"] { background: linear-gradient(135deg, #0a0a0c 0 50%, #ff2b2b 50% 100%); }
    .theme-btn[data-theme="cyberpunk"] { background: linear-gradient(135deg, #0b0b1c 0 50%, #ff2d95 50% 68%, #2de2ff 68% 100%); }
    @media (max-width: 820px) { #themeSwitch .theme-label { display: none; } #themeSwitch { justify-content: center; } }

    /* Gateway controls pinned in the rail footer — always reachable, not
       buried in the Models tab. Restart is destructive (drops in-flight
       turns), so it carries the accent border as a visual warning. */
    .railnav .rail-gw { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 6px; }
    .railnav .rail-gw button {
      display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%;
      background: transparent; border: 1px solid var(--line); color: var(--muted);
      padding: 7px 6px; border-radius: var(--radius-sm); cursor: pointer;
      font-size: 12px; font-family: inherit; white-space: nowrap;
    }
    .railnav .rail-gw button:hover:not(:disabled) { color: var(--text); border-color: var(--accent); }
    .railnav .rail-gw button:disabled { opacity: 0.4; cursor: not-allowed; }
    .railnav .rail-gw button.busy { opacity: 0.6; pointer-events: none; }
    .railnav .rail-gw #railRestart:hover:not(:disabled) { color: var(--accent); }
    .rail-gw-status { font-size: 11px; color: var(--muted); line-height: 1.4; margin-bottom: 8px; min-height: 0; word-break: break-word; }
    .rail-gw-status:empty { display: none; }

    /* Content column: slim topbar (live status) + the working body. */
    .content { display: grid; grid-template-rows: 44px 1fr; min-width: 0; min-height: 0; }
    .topbar {
      display: flex; align-items: center; gap: 12px;
      padding: 0 20px; border-bottom: 1px solid var(--line); background: var(--bg);
    }
    .topbar .status { color: var(--muted); font-size: 12px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-width: 0; }
    .topbar .status .status-pill { white-space: nowrap; padding: 2px 8px; border-radius: 10px; background: var(--panel); border: 1px solid var(--line); }

    .body { display: grid; grid-template-columns: 280px 1fr; min-height: 0; min-width: 0; }
    .body.no-sidebar { grid-template-columns: 1fr; }

    @media (max-width: 820px) {
      :root { --rail-w: 60px; }
      .railnav .brand-name, .nav-group-label, .railnav nav button span:not(.nav-ico), #setupBtn span:not(.nav-ico) { display: none; }
      .railnav nav button { justify-content: center; }
      /* Collapsed rail: gateway controls stack to icon-only, one per row. */
      .railnav .rail-gw { grid-template-columns: 1fr; }
      .railnav .rail-gw button span:not(.nav-ico) { display: none; }
      .rail-gw-status { display: none; }
    }
    .sidebar {
      background: var(--panel);
      border-right: 1px solid var(--line);
      display: flex; flex-direction: column; min-height: 0;
    }
    .sidebar header.sub { height: 40px; padding: 0 12px; border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; }
    .sidebar h2 { margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
    .sidebar .add { background: var(--accent-soft); color: var(--accent); border: 1px solid var(--line); border-radius: 4px; padding: 2px 8px; font-size: 12px; cursor: pointer; }
    .sidebar ul { list-style: none; margin: 0; padding: 4px; overflow: auto; flex: 1; }
    .sidebar li {
      padding: 8px 10px; border-radius: 6px; cursor: pointer; margin-bottom: 2px;
      display: flex; flex-direction: column; gap: 2px;
    }
    .sidebar li:hover { background: var(--panel-2); }
    .sidebar li.active { background: var(--panel-2); border: 1px solid var(--line); }
    .sidebar li .title { color: var(--text); font-weight: 600; font-size: 13px; }
    .sidebar li .preview { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .main { display: flex; flex-direction: column; min-height: 0; }
    .thread { flex: 1; overflow: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; }
    .msg { max-width: 720px; padding: 10px 12px; border-radius: 10px; line-height: 1.5; word-wrap: break-word; }
    .msg.user { background: var(--user); align-self: flex-end; white-space: pre-wrap; }
    .msg.assistant { background: var(--assistant); border: 1px solid var(--line); align-self: flex-start; }
    .msg .meta { color: var(--muted); font-size: 11px; margin-bottom: 4px; }
    .msg .body { display: block; }
    .msg .body p { margin: 0 0 8px; }
    .msg .body p:last-child { margin-bottom: 0; }
    .msg .body h2, .msg .body h3, .msg .body h4 { margin: 12px 0 6px; line-height: 1.25; }
    .msg .body h2 { font-size: 18px; }
    .msg .body h3 { font-size: 16px; }
    .msg .body h4 { font-size: 14px; color: var(--accent); }
    .msg .body ul, .msg .body ol { margin: 6px 0 8px; padding-left: 22px; }
    .msg .body li { margin: 2px 0; }
    .msg .body blockquote { margin: 6px 0; padding: 4px 12px; border-left: 3px solid var(--accent); color: var(--muted); }
    .msg .body a { color: var(--accent); }
    .msg .body code.md-inline { background: var(--bg); padding: 1px 5px; border-radius: 3px; font: 12px ui-monospace, Menlo, monospace; border: 1px solid var(--line); }
    .msg .body pre.md-code { margin: 8px 0; padding: 10px 12px; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; overflow-x: auto; }
    .msg .body pre.md-code code { font: 12px/1.5 ui-monospace, Menlo, monospace; }
    .msg .body strong { font-weight: 700; }
    .composer { border-top: 1px solid var(--line); padding: 12px 16px; background: var(--panel); display: flex; gap: 8px; align-items: flex-end; }
    .composer textarea {
      flex: 1; min-height: 38px; max-height: 200px; resize: none;
      background: var(--bg); color: var(--text); border: 1px solid var(--line);
      border-radius: 8px; padding: 9px 12px; font: inherit; outline: none;
    }
    .composer textarea:focus { border-color: var(--accent); }
    .composer button {
      background: var(--accent); color: #0a0203; border: 0;
      padding: 9px 14px; border-radius: 2px; font-weight: 700; cursor: pointer;
      clip-path: polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px);
      letter-spacing: 0.08em; text-transform: uppercase; font-size: 12px;
      transition: box-shadow .15s, filter .15s;
    }
    .composer button:hover:not(:disabled) { filter: brightness(1.15); box-shadow: var(--glow-md); }
    .composer button:disabled { opacity: 0.5; cursor: not-allowed; }

    .pane { flex: 1; overflow: auto; padding: 24px 32px 60px; }
    .pane > * { max-width: 1180px; margin-left: auto; margin-right: auto; }
    .pane h2 { margin: 0 0 14px; font-size: 20px; letter-spacing: -0.01em; }
    .pane h3 { margin: 22px 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 600; }
    .pane > .row, .pane > .grid { max-width: 1180px; margin-left: auto; margin-right: auto; }
    .pane pre { max-height: 320px; overflow: auto; }
    .grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
    .grid.two { grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); }
    .grid.stats { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; }
    .card .name { font-weight: 700; }
    .card .desc { color: var(--muted); font-size: 12px; margin-top: 4px; line-height: 1.5; }
    .card .stat-value { font-size: 22px; font-weight: 700; margin-top: 4px; }
    .muted { color: var(--muted); }

    /* Memory tab */
    .tier-pills { display: flex; gap: 4px; }
    .tier-pills button { background: var(--panel); color: var(--muted); border: 1px solid var(--line); padding: 6px 14px; border-radius: 18px; font: inherit; font-size: 12px; cursor: pointer; }
    .tier-pills button .count { color: var(--muted); margin-left: 6px; font-size: 11px; }
    .tier-pills button:hover { color: var(--text); border-color: #4a2a24; }
    .tier-pills button.active { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
    .tier-pills button.active .count { color: var(--accent); }
    .mem-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; max-width: 1180px; margin: 0 auto; }
    .mem-card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 8px; min-height: 140px; }
    .mem-card.tier-short { border-left: 3px solid #ff2b2b; }
    .mem-card.tier-medium { border-left: 3px solid #f0b454; }
    .mem-card.tier-long { border-left: 3px solid #ff7a45; }
    .mem-head { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; }
    .mem-head .badge.tier-short { background: rgba(255,43,43,0.12); color: #ff5a4a; border-color: rgba(255,43,43,0.3); }
    .mem-head .badge.tier-medium { background: rgba(240,180,84,0.12); color: #f0b454; border-color: rgba(240,180,84,0.3); }
    .mem-head .badge.tier-long { background: rgba(255,122,69,0.12); color: #ff7a45; border-color: rgba(255,122,69,0.3); }
    .mem-age { color: var(--muted); font-size: 11px; margin-left: auto; }
    .mem-content { font-size: 13px; line-height: 1.5; max-height: 8.4em; overflow: hidden; position: relative; word-break: break-word; }
    .mem-content::after { content: ""; position: absolute; bottom: 0; left: 0; right: 0; height: 1.6em; background: linear-gradient(transparent, var(--panel)); pointer-events: none; }
    .mem-tags { display: flex; gap: 4px; flex-wrap: wrap; }
    .chip { background: var(--bg); color: var(--muted); padding: 2px 8px; border-radius: 10px; font-size: 11px; border: 1px solid var(--line); white-space: nowrap; }

    /* OAuth banner */
    .warn-banner { border-color: var(--warn); background: rgba(240,180,84,0.08); margin: 12px 0; }
    .btn-primary { background: var(--accent); color: #0a0203; padding: 8px 14px; border-radius: 2px; font-weight: 700; text-decoration: none; display: inline-block; clip-path: polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px); letter-spacing: 0.08em; text-transform: uppercase; font-size: 12px; }
    .btn-primary:hover { opacity: 0.9; }
    .row { display: flex; gap: 8px; align-items: center; }
    .row.between { justify-content: space-between; }
    .row > .grow { flex: 1; }
    .badge { font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--panel-2); color: var(--muted); border: 1px solid var(--line); }
    .badge.ok { color: var(--accent); }
    .badge.warn { color: var(--warn); }
    .badge.err { color: var(--err); }
    .badge.mcp { background: rgba(255,90,74,.14); color: #ff8a7a; border-color: rgba(255,90,74,.35); }
    .badge.muted { opacity: .65; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text); }
    input, select, textarea {
      background: var(--bg); color: var(--text); border: 1px solid var(--line);
      border-radius: 6px; padding: 6px 10px; font: inherit; outline: none;
    }
    input:focus, textarea:focus, select:focus { border-color: var(--accent); }
    button.secondary { background: var(--panel-2); color: var(--text); border: 1px solid var(--line); padding: 6px 10px; border-radius: 6px; cursor: pointer; }
    button.secondary:hover { border-color: var(--accent); color: var(--accent); }
    .form { display: grid; gap: 8px; }
    .form label { font-size: 12px; color: var(--muted); display: block; margin-bottom: 2px; }
    .ok { color: var(--accent); }
    .err { color: var(--err); }
    .empty { color: var(--muted); padding: 16px; text-align: center; }

    /* ─── Primitive components (shadcn-style, vanilla CSS) ───────────────
       Every new feature should compose these instead of inline styles. */

    .ui-section { margin-top: var(--space-5); }
    .ui-section:first-child { margin-top: 0; }
    .ui-section-header { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-3); }
    .ui-section-header h3 { margin: 0; font-size: var(--font-size-base); font-weight: 600; }
    .ui-section-header .ui-section-meta { color: var(--muted-foreground); font-weight: 400; font-size: var(--font-size-sm); }

    .ui-card {
      background: var(--card);
      color: var(--card-foreground);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: var(--space-3) var(--space-4);
    }
    .ui-card.ui-card-elev { box-shadow: var(--shadow-sm); }

    .ui-empty {
      color: var(--muted-foreground);
      background: var(--muted-bg);
      border: 1px dashed var(--border);
      border-radius: var(--radius);
      padding: var(--space-4);
      text-align: center;
      font-size: var(--font-size-sm);
    }

    .ui-btn {
      display: inline-flex; align-items: center; gap: var(--space-2); justify-content: center;
      background: var(--primary); color: var(--primary-foreground);
      border: 1px solid transparent; border-radius: var(--radius-sm);
      padding: 6px 12px; font-size: var(--font-size-sm); font-weight: 600;
      cursor: pointer; transition: opacity .12s ease, background .12s ease;
      font-family: inherit;
    }
    .ui-btn:hover:not(:disabled) { opacity: 0.9; }
    .ui-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .ui-btn:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
    .ui-btn-secondary {
      background: var(--secondary); color: var(--secondary-foreground);
      border: 1px solid var(--border);
    }
    .ui-btn-secondary:hover:not(:disabled) { background: var(--card); }
    .ui-btn-ghost {
      background: transparent; color: var(--foreground);
      border: 1px solid transparent;
    }
    .ui-btn-ghost:hover:not(:disabled) { background: var(--muted-bg); }
    .ui-btn-destructive {
      background: var(--destructive); color: var(--destructive-foreground);
    }
    .ui-btn-sm { padding: 3px 9px; font-size: var(--font-size-xs); }

    .ui-input, .ui-textarea, .ui-select {
      background: var(--input); color: var(--foreground);
      border: 1px solid var(--border); border-radius: var(--radius-sm);
      padding: 6px 10px; font-size: var(--font-size-sm); font-family: inherit;
      width: 100%; outline: none;
    }
    .ui-input:focus, .ui-textarea:focus, .ui-select:focus { border-color: var(--primary); box-shadow: 0 0 0 2px var(--ring); }
    .ui-textarea { resize: vertical; min-height: 36px; line-height: 1.4; }

    .ui-badge {
      display: inline-flex; align-items: center; gap: 3px;
      font-size: var(--font-size-xs); padding: 2px 7px; border-radius: 999px;
      background: var(--muted-bg); color: var(--muted-foreground);
      border: 1px solid var(--border); white-space: nowrap;
    }
    .ui-badge-accent { background: var(--accent-bg); color: var(--accent-foreground); border-color: var(--accent-bg); }
    .ui-badge-warn { color: var(--warn); }
    .ui-badge-err { color: var(--err); border-color: rgba(240,128,128,.3); }

    .ui-divider { border: 0; border-top: 1px solid var(--border); margin: var(--space-4) 0; }

    .ui-row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
    .ui-stack { display: flex; flex-direction: column; gap: var(--space-2); }
    .ui-grow { flex: 1; min-width: 0; }
    .ui-muted { color: var(--muted-foreground); }
    .ui-meta { font-size: var(--font-size-xs); color: var(--muted-foreground); }

    .ui-kbd {
      display: inline-block; font-family: ui-monospace, Menlo, monospace;
      font-size: 10px; padding: 1px 5px; border-radius: 3px;
      background: var(--muted-bg); border: 1px solid var(--border); color: var(--muted-foreground);
    }

    /* Toasts stack in the top-right and fade out at the end of their
       lifetime. Replaces the ad-hoc inline-styled toast we used before. */
    .ui-toast-stack {
      position: fixed; top: 20px; right: 20px; z-index: 99;
      display: flex; flex-direction: column; gap: var(--space-2);
      max-width: 360px; pointer-events: none;
    }
    .ui-toast {
      padding: 10px 14px; border-radius: var(--radius); font-size: 13px;
      line-height: 1.4; box-shadow: var(--shadow); pointer-events: auto;
      transition: opacity .35s ease, transform .35s ease;
    }
    .ui-toast-ok { background: #2a1610; color: #ff9a7a; border: 1px solid #4a2a1e; }
    .ui-toast-err { background: #3a1a1a; color: #f08a8a; border: 1px solid #5b2d2d; }
    .ui-toast-leaving { opacity: 0; transform: translateX(8px); }

    /* (?) help marker for obscure terms. Hover shows a small tooltip with
       an explanation. Use uiHelp(text) to render. */
    .ui-help {
      display: inline-flex; align-items: center; justify-content: center;
      width: 14px; height: 14px; border-radius: 50%;
      background: var(--muted-bg); border: 1px solid var(--border);
      color: var(--muted-foreground); font-size: 10px; font-weight: 700;
      margin-left: 4px; cursor: help; position: relative; user-select: none;
      vertical-align: middle;
    }
    .ui-help:hover { color: var(--accent-foreground); background: var(--accent-bg); border-color: var(--accent-bg); }
    .ui-help:hover .ui-help-tip { display: block; }
    .ui-help .ui-help-tip {
      display: none; position: absolute; bottom: calc(100% + 6px); left: 50%;
      transform: translateX(-50%); z-index: 100;
      background: var(--popover); color: var(--popover-foreground);
      border: 1px solid var(--border); border-radius: var(--radius);
      padding: 8px 10px; font-size: 12px; font-weight: 400;
      width: max-content; max-width: 280px;
      box-shadow: var(--shadow); cursor: default; line-height: 1.4;
      text-align: left; white-space: normal;
    }

    /* Task list — rows have a clear hover affordance and a settled
       baseline grid (10px vertical pad keeps line-height aligned with
       checkbox baseline). */
    .ui-task-list { list-style: none; padding: 0; margin: 0; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
    .ui-task-row {
      display: flex; gap: var(--space-3); align-items: flex-start;
      padding: 10px var(--space-3); border-bottom: 1px solid var(--border);
      transition: background .12s ease;
    }
    .ui-task-row:last-child { border-bottom: 0; }
    .ui-task-row:hover { background: var(--muted-bg); }
    .ui-task-check { margin-top: 4px; cursor: pointer; }
    .ui-task-title { font-weight: 500; font-size: var(--font-size-sm); }

    /* Page-chat composer (Tasks/Memory/Suggestions inline send-to-agent) */
    .page-chat .page-chat-input { /* already laid out inline; promote to token-driven */
      background: var(--input); color: var(--foreground);
      border: 1px solid var(--border); border-radius: var(--radius-sm);
    }
    .page-chat .page-chat-input:focus { border-color: var(--primary); box-shadow: 0 0 0 2px var(--ring); outline: none; }
    .page-chat .page-chat-send {
      background: var(--primary); color: var(--primary-foreground);
      border: 0; border-radius: var(--radius-sm); padding: 6px 14px;
      font-weight: 600; font-size: var(--font-size-sm); cursor: pointer;
    }
    .page-chat .page-chat-send:hover:not(:disabled) { opacity: 0.9; }
    .page-chat .page-chat-send:disabled { opacity: 0.5; cursor: not-allowed; }

    /* ═══ CERBERUS panel system (ref-05 laser-console idiom) ═══════════════
       HUD tables, status pills with pulsing dots, a REBOOTING-LASERS-style
       modal with segmented progress + streaming mono log, and serial-number
       micro-labels on cards. */

    /* Console tables — hairline rules, tracked mono headers, row hover glow. */
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    table th {
      text-align: left; font-family: var(--font-display); text-transform: uppercase;
      letter-spacing: 0.12em; font-size: 10px; font-weight: 600; color: var(--muted);
      padding: 6px 10px; border-bottom: 1px solid var(--line-hot);
      background: rgba(255,43,43,.04);
    }
    table td {
      padding: 7px 10px; border-bottom: 1px solid var(--line);
      font-family: var(--font-mono); color: var(--text);
    }
    table tbody tr { transition: background .12s ease; }
    table tbody tr:hover { background: rgba(255,43,43,.05); }
    table tbody tr:last-child td { border-bottom: 0; }

    /* Status pills — ONLINE / OFFLINE (ref-05). Emissive pulsing dot. */
    .pill {
      display: inline-flex; align-items: center; gap: 6px;
      font-family: var(--font-mono); font-size: 10px; letter-spacing: .16em;
      text-transform: uppercase; padding: 3px 10px;
      border: 1px solid var(--line); color: var(--muted); background: var(--panel);
      clip-path: polygon(5px 0, 100% 0, 100% calc(100% - 5px), calc(100% - 5px) 100%, 0 100%, 0 5px);
    }
    .pill::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: var(--muted); }
    .pill.online { color: var(--accent); border-color: var(--line-hot); }
    .pill.online::before { background: var(--accent); box-shadow: var(--glow-sm); animation: cerb-pulse 2s ease-in-out infinite; }
    .pill.offline { color: var(--muted); }
    .pill.offline::before { background: var(--muted); opacity: .5; }
    .pill.warn { color: var(--warn); border-color: rgba(240,180,84,.3); }
    .pill.warn::before { background: var(--warn); box-shadow: 0 0 6px rgba(240,180,84,.4); animation: cerb-pulse 1.4s ease-in-out infinite; }

    /* Card serial micro-label — tiny mono serial in the corner (ref-04/06). */
    .card .serial, .ui-card .serial {
      position: absolute; top: 5px; right: 8px;
      font-family: var(--font-mono); font-size: 8px; letter-spacing: .18em;
      color: var(--muted); opacity: .45; text-transform: uppercase; pointer-events: none;
    }
    .card .name, .card .stat-value { position: relative; }

    /* ── Modal (REBOOTING LASERS pattern) ───────────────────────────────────
       Bordered chamfered dialog, segmented progress bar, streaming mono log.
       Driven by cerbModal() in the script section. */
    .cerb-modal-overlay {
      position: fixed; inset: 0; z-index: 300; display: none;
      align-items: center; justify-content: center;
      background: rgba(3,3,4,.78); backdrop-filter: blur(2px);
    }
    .cerb-modal-overlay.open { display: flex; }
    .cerb-modal {
      width: min(460px, 92vw); background: var(--panel); border: 1px solid var(--line-hot);
      clip-path: polygon(var(--chamfer) 0, 100% 0, 100% calc(100% - var(--chamfer)), calc(100% - var(--chamfer)) 100%, 0 100%, 0 var(--chamfer));
      box-shadow: 0 0 0 1px rgba(255,43,43,.15), var(--glow-md), var(--shadow);
      padding: 18px 20px; position: relative;
    }
    .cerb-modal .cerb-modal-title {
      font-family: var(--font-display); text-transform: uppercase; letter-spacing: .16em;
      font-size: 13px; font-weight: 600; color: var(--accent); margin: 0 0 12px;
      display: flex; align-items: center; gap: 8px;
    }
    .cerb-modal .cerb-modal-title::before {
      content: ""; width: 6px; height: 6px; background: var(--accent);
      box-shadow: var(--glow-sm); animation: cerb-pulse 1.2s ease-in-out infinite;
    }
    /* Segmented progress bar. */
    .cerb-progress { display: flex; gap: 3px; margin: 12px 0; }
    .cerb-progress .seg {
      flex: 1; height: 6px; background: var(--panel-2); border: 1px solid var(--line);
      transform: skewX(-18deg);
    }
    .cerb-progress .seg.fill { background: var(--accent); box-shadow: var(--glow-sm); border-color: var(--line-hot); }
    /* Streaming log beneath the progress. */
    .cerb-log {
      font-family: var(--font-mono); font-size: 10px; line-height: 1.6;
      color: var(--muted); background: var(--bg); border: 1px solid var(--line);
      padding: 8px 10px; max-height: 120px; overflow-y: auto; white-space: pre-wrap;
    }
    .cerb-log .ln-ok { color: var(--accent); }
    .cerb-log .ln-dim { color: var(--muted); opacity: .6; }

    /* Section headers get a tracked HUD label + hairline rule. */
    .pane h3 { position: relative; padding-bottom: 6px; }
    .pane h3::after {
      content: ""; position: absolute; left: 0; bottom: 0; width: 28px; height: 1px;
      background: var(--accent); box-shadow: var(--glow-sm);
    }

    /* ═══ CERBERUS / TRON:ARES chrome layer ═══════════════════════════════
       Chamfered HUD panels, corner ticks, emissive edges, scanline +
       drifting-grid ambience. All motion is transform/opacity only and
       gated behind prefers-reduced-motion. Red is glow, never fill. */

    /* Chamfered corners on every panel family. The 1px border is clipped
       along the diagonal, which reads as an intentional cut edge; corner
       ticks (below) accent it on hover / active. */
    .card, .ui-card, .mem-card, .ui-empty, .composer, .topbar .status .status-pill {
      clip-path: polygon(var(--chamfer) 0, 100% 0, 100% calc(100% - var(--chamfer)), calc(100% - var(--chamfer)) 100%, 0 100%, 0 var(--chamfer));
    }
    .composer { clip-path: none; } /* keep the composer full-bleed at the bottom */

    /* Corner tick brackets — top-left + bottom-right L-marks that light up
       on hover. Pure pseudo-elements, no extra markup. */
    .card, .ui-card, .mem-card { position: relative; }
    .card::before, .ui-card::before, .mem-card::before,
    .card::after, .ui-card::after, .mem-card::after {
      content: ""; position: absolute; width: 10px; height: 10px;
      border: 1px solid var(--accent); opacity: 0;
      transition: opacity .18s ease; pointer-events: none;
    }
    .card::before, .ui-card::before, .mem-card::before {
      top: 3px; left: 3px; border-right: 0; border-bottom: 0;
    }
    .card::after, .ui-card::after, .mem-card::after {
      bottom: 3px; right: 3px; border-left: 0; border-top: 0;
    }
    .card:hover::before, .ui-card:hover::before, .mem-card:hover::before,
    .card:hover::after, .ui-card:hover::after, .mem-card:hover::after { opacity: .9; }

    /* Emissive edge on hover — a soft red edge-light, not a fill. */
    .card, .ui-card, .mem-card { transition: border-color .18s ease, box-shadow .18s ease, transform .18s ease; }
    .card:hover, .ui-card:hover, .mem-card:hover {
      border-color: var(--line-hot);
      box-shadow: 0 0 0 1px rgba(255,43,43,.12), var(--glow-sm);
    }

    /* Interactive glow — buttons/pills bloom + lift on hover, flash on
       press. transform/box-shadow/opacity only (GPU-cheap, no layout).
       The slight translateY reads as a 3D pop without a real perspective
       pass, which keeps it cheap on the shared box. */
    .ui-btn, .composer button, .sidebar .add, .tier-pills button {
      transition: box-shadow .16s ease, transform .16s ease,
                  filter .16s ease, border-color .16s ease, background .16s ease;
    }
    .ui-btn:hover:not(:disabled), .composer button:hover:not(:disabled),
    .sidebar .add:hover:not(:disabled), .tier-pills button:hover:not(:disabled) {
      box-shadow: 0 0 0 1px rgba(255,43,43,.22), var(--glow-md);
      transform: translateY(-1px);
    }
    .ui-btn:active:not(:disabled), .composer button:active:not(:disabled),
    .sidebar .add:active:not(:disabled), .tier-pills button:active:not(:disabled) {
      transform: translateY(0) scale(.985);
      filter: brightness(1.5);
      box-shadow: 0 0 0 1px rgba(255,90,74,.5), var(--glow-md);
    }
    /* Primary send button gets a stronger emissive bloom — it's the hero
       action on the chat pane. */
    .composer button:hover:not(:disabled) { filter: brightness(1.2); }

    /* Display type — wide-tracked uppercase for headings + brand. */
    .pane h2, .railnav .brand-name {
      font-family: var(--font-display);
      text-transform: uppercase;
      letter-spacing: 0.14em;
      font-weight: 600;
    }
    .pane h2 { font-size: 18px; }
    .pane h3, .nav-group-label, .sidebar h2 {
      font-family: var(--font-display);
      letter-spacing: 0.16em;
    }
    /* Telemetry / numbers go monospace. */
    .card .stat-value, .topbar .status, pre, code, .ui-kbd, .chip, .badge {
      font-family: var(--font-mono);
    }

    /* HUD micro-label — tiny tracked serial line used on section headers. */
    .hud-label {
      font-family: var(--font-mono); font-size: 9px; letter-spacing: 0.22em;
      text-transform: uppercase; color: var(--muted); opacity: .7;
    }

    /* Status pills — emissive dot + tracked mono caps (ref-05 OFFLINE idiom). */
    .topbar .status .status-pill {
      display: inline-flex; align-items: center; gap: 6px;
      font-family: var(--font-mono); font-size: 10px; letter-spacing: .14em;
      text-transform: uppercase; color: var(--muted);
      background: var(--panel); border: 1px solid var(--line);
      padding: 3px 10px;
    }
    .topbar .status .status-pill::before {
      content: ""; width: 5px; height: 5px; border-radius: 50%;
      background: var(--accent); box-shadow: var(--glow-sm);
      animation: cerb-pulse 2.2s ease-in-out infinite;
    }

    /* Scanline + vignette overlay — static, GPU-cheap, pointer-transparent. */
    body::after {
      content: ""; position: fixed; inset: 0; z-index: 200; pointer-events: none;
      background:
        repeating-linear-gradient(0deg, rgba(255,255,255,.014) 0 1px, transparent 1px 3px),
        radial-gradient(120% 90% at 50% 0%, transparent 55%, rgba(0,0,0,.5) 100%);
    }

    /* Ambient drifting circuit grid behind the whole app. Two layered
       linear-gradient grids translate slowly (transform only). Paused for
       reduced-motion users. */
    body::before {
      content: ""; position: fixed; inset: -120px; z-index: 0; pointer-events: none;
      background:
        linear-gradient(rgba(255,43,43,.045) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,43,43,.045) 1px, transparent 1px),
        linear-gradient(rgba(255,43,43,.02) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,43,43,.02) 1px, transparent 1px);
      background-size: 96px 96px, 96px 96px, 24px 24px, 24px 24px;
      animation: cerb-grid-drift 60s linear infinite;
      opacity: .5;
    }
    .app { position: relative; z-index: 1; }
    @keyframes cerb-grid-drift {
      from { transform: translate3d(0, 0, 0); }
      to   { transform: translate3d(96px, 96px, 0); }
    }
    @keyframes cerb-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: .35; }
    }

    /* Panel materialise — rise + one-shot scanline sweep on tab entry.
       Applied by the motion layer to the main pane (class .cerb-in).
       Strictly transform/opacity (no filter repaint) so it stays GPU-cheap
       on the shared WSL box; the sweep is a compositor-friendly gradient
       band that travels once and fades. */
    .cerb-in { position: relative; animation: cerb-materialise .22s cubic-bezier(.2,.8,.3,1) both; }
    .cerb-in::after {
      content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 5;
      background: linear-gradient(180deg,
        transparent 0%, rgba(255,90,74,.10) 46%, rgba(255,43,43,.20) 50%,
        rgba(255,90,74,.10) 54%, transparent 100%);
      background-size: 100% 240%;
      mix-blend-mode: screen;
      animation: cerb-sweep .5s cubic-bezier(.2,.8,.3,1) both;
    }
    @keyframes cerb-materialise {
      0%   { opacity: 0; transform: translateY(8px) scale(.996); }
      55%  { opacity: 1; }
      100% { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes cerb-sweep {
      from { background-position: 0% 130%; opacity: 1; }
      to   { background-position: 0% -130%; opacity: 0; }
    }

    /* ─── Holo hero — volumetric Cerberus projection (ref-02) ────────────
       The empty chat pane becomes a holographic emitter: a raw-WebGL
       wireframe of the three-wolf mark floating over a perspective grid
       plane, wrapped in HUD chrome (corner ticks, tracked captions, a
       live status line). The canvas itself is inert — all motion lives
       in the GL loop, which is hard-capped: it only runs while the Chat
       tab is active AND the document is visible, and renders a single
       static frame under prefers-reduced-motion. */
    .holo-hero {
      position: relative; width: 100%; max-width: 620px;
      margin: var(--space-5) auto 0; padding: 0;
      border: 1px solid var(--line);
      clip-path: polygon(var(--chamfer) 0, 100% 0, 100% calc(100% - var(--chamfer)), calc(100% - var(--chamfer)) 100%, 0 100%, 0 var(--chamfer));
      background:
        radial-gradient(90% 70% at 50% 30%, rgba(255,43,43,.07) 0%, transparent 60%),
        linear-gradient(180deg, rgba(12,13,16,.4) 0%, rgba(5,5,6,.9) 100%);
      overflow: hidden;
    }
    .holo-hero canvas { display: block; width: 100%; height: 300px; }
    .holo-hero .holo-cap {
      position: absolute; top: 8px; left: 12px;
      font-family: var(--font-mono); font-size: 9px; letter-spacing: .26em;
      text-transform: uppercase; color: var(--accent); opacity: .85;
      text-shadow: var(--glow-sm); pointer-events: none;
    }
    .holo-hero .holo-status {
      position: absolute; bottom: 8px; right: 12px;
      font-family: var(--font-mono); font-size: 9px; letter-spacing: .2em;
      text-transform: uppercase; color: var(--muted); pointer-events: none;
    }
    .holo-hero .holo-status::before {
      content: ""; display: inline-block; width: 5px; height: 5px;
      border-radius: 50%; background: var(--accent); box-shadow: var(--glow-sm);
      margin-right: 6px; vertical-align: 1px;
      animation: cerb-pulse 2.2s ease-in-out infinite;
    }
    /* Corner ticks on the emitter frame. */
    .holo-hero::before, .holo-hero::after {
      content: ""; position: absolute; width: 12px; height: 12px;
      border: 1px solid var(--accent); opacity: .7; pointer-events: none; z-index: 2;
    }
    .holo-hero::before { top: 4px; left: 4px; border-right: 0; border-bottom: 0; }
    .holo-hero::after { bottom: 4px; right: 4px; border-left: 0; border-top: 0; }

    /* Respect reduced motion — freeze the drift, pulse, and materialise. */
    @media (prefers-reduced-motion: reduce) {
      body::before { animation: none; }
      .topbar .status .status-pill::before { animation: none; }
      .cerb-in { animation: none; }
      .cerb-in::after { animation: none; opacity: 0; }
      .railnav nav button.active::after { animation: none; opacity: .6; }
      .card, .ui-card, .mem-card { transition: none; }
      .ui-btn, .composer button, .sidebar .add, .tier-pills button { transition: none; }
      .ui-btn:hover:not(:disabled), .composer button:hover:not(:disabled),
      .sidebar .add:hover:not(:disabled), .tier-pills button:hover:not(:disabled) { transform: none; }
      .holo-hero .holo-status::before { animation: none; }
    }
    /* Run Inspector: metadata-only live execution visibility. */
    .run-toolbar { display:flex; gap:var(--space-2); align-items:center; flex-wrap:wrap; margin-bottom:var(--space-4); }
    .run-layout { display:grid; grid-template-columns:minmax(280px, .8fr) minmax(420px, 1.6fr); gap:var(--space-4); align-items:start; }
    .run-list { display:flex; flex-direction:column; gap:var(--space-2); max-height:72vh; overflow:auto; }
    .run-row { width:100%; cursor:pointer; text-align:left; color:inherit; font:inherit; transition:border-color .12s ease, background .12s ease; }
    .run-row:hover, .run-row.active { border-color:var(--primary); background:var(--muted-bg); }
    .run-timeline { display:flex; flex-direction:column; gap:0; border-left:2px solid var(--border); margin-left:8px; padding-left:16px; }
    .run-event { position:relative; padding:0 0 14px; }
    .run-event::before { content:""; position:absolute; width:8px; height:8px; border-radius:50%; background:var(--primary); left:-21px; top:5px; }
    .run-event:last-child { padding-bottom:0; }
    .run-metrics { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:var(--space-2); }
    .qa-evidence-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:var(--space-3); }
    .qa-shot { width:100%; max-height:280px; object-fit:contain; background:var(--input); border:1px solid var(--border); border-radius:var(--radius-sm); margin-top:var(--space-2); }
    .qa-result-failed { border-color:rgba(240,128,128,.5); }
    @media (max-width:900px) { .run-layout { grid-template-columns:1fr; } .run-list { max-height:40vh; } }

    /* Ops: unified live observability for skills, learning, tools, vision,
       computer-use, and debug/runtime events. */
    .ops-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:var(--space-3); margin-bottom:var(--space-4); }
    .ops-stat { padding:var(--space-3); border:1px solid var(--border); background:var(--card); border-radius:var(--radius); }
    .ops-stat .ops-num { font-family:var(--font-display); font-size:24px; color:var(--primary); line-height:1; }
    .ops-stat .ops-label { margin-top:6px; color:var(--muted-foreground); font-size:var(--font-size-xs); text-transform:uppercase; letter-spacing:.08em; }
    .ops-toolbar { display:flex; gap:var(--space-2); align-items:center; flex-wrap:wrap; margin-bottom:var(--space-3); }
    .ops-filter { border:1px solid var(--border); background:var(--input); color:var(--foreground); border-radius:999px; padding:4px 10px; font-size:var(--font-size-xs); cursor:pointer; }
    .ops-filter.active { border-color:var(--primary); color:var(--primary); background:var(--accent-soft); }
    .ops-feed { display:flex; flex-direction:column; gap:var(--space-2); max-height:58vh; overflow:auto; }
    .ops-event { display:grid; grid-template-columns:132px 1fr; gap:var(--space-3); padding:var(--space-3); border:1px solid var(--border); background:var(--card); border-radius:var(--radius); }
    .ops-event .ops-time { color:var(--muted-foreground); font-family:var(--font-mono); font-size:var(--font-size-xs); }
    .ops-event .ops-title { font-weight:650; }
    .ops-event .ops-detail { margin-top:4px; color:var(--muted-foreground); font-size:var(--font-size-sm); white-space:pre-wrap; }
    .ops-cat { display:inline-flex; align-items:center; gap:4px; margin-right:8px; color:var(--primary); font-size:var(--font-size-xs); text-transform:uppercase; letter-spacing:.07em; }
    .ops-event[data-tone="err"] { border-color:rgba(240,128,128,.55); }
    .ops-event[data-tone="ok"] { border-color:rgba(80,200,120,.35); }
    .ops-event[data-tone="think"] { border-color:rgba(155,89,182,.45); }
    @media (max-width:760px) { .ops-event { grid-template-columns:1fr; } }
  </style>
</head>
<body>
<canvas id="cerbBg" aria-hidden="true"></canvas>
<div class="app">
  <aside class="railnav">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">${cerbMarkSVG(28, { stroke: "var(--accent)" })}</span>
      <span class="brand-name">Cerberus</span>
    </div>
    <nav id="nav">
      <div class="nav-group-label">Workspace</div>
      <button data-tab="chat" class="active" title="Talk to your agent in natural language."><span class="nav-ico">${hudIcon("chat")}</span><span>Chat</span></button>
      <button data-tab="tasks" title="My tasks + agent tasks. The agent's own queue gets drained every 30 min by the autopilot pulse."><span class="nav-ico">${hudIcon("tasks")}</span><span>Tasks</span></button>
      <button data-tab="suggestions" title="Things the proactive observer noticed + agent actions awaiting your approval."><span class="nav-ico">${hudIcon("suggestions")}</span><span>Suggestions</span></button>
      <button data-tab="memory" title="Short, medium, and long-term memory. Promotion happens automatically."><span class="nav-ico">${hudIcon("memory")}</span><span>Memory</span></button>
      <button data-tab="integrations" title="Connect MCPs (Linear, GitHub, Stripe, …), sources (BuildBetter, Rize, inbox folder), and channels (Telegram)."><span class="nav-ico">${hudIcon("integrations")}</span><span>Integrations</span></button>

      <div class="nav-group-label">Build</div>
      <button data-tab="projects" title="Isolated workspaces, policies, skills, MCP grants, sessions, and artifacts."><span class="nav-ico">${hudIcon("projects")}</span><span>Projects</span></button>
      <button data-tab="mcp" title="Register custom MCP servers or manage already-registered ones."><span class="nav-ico">${hudIcon("mcp")}</span><span>MCP</span></button>
      <button data-tab="models" title="Which model provider is live, API keys for Anthropic / OpenAI / xAI / OpenRouter / Kimi, and gateway update + restart."><span class="nav-ico">${hudIcon("models")}</span><span>Models</span></button>
      <button data-tab="skills" title="Reusable named prompts. Mined from your activity, or hand-authored."><span class="nav-ico">${hudIcon("skills")}</span><span>Skills</span></button>
      <button data-tab="cron" title="Scheduled prompts + the agent's autopilot pulse cron jobs."><span class="nav-ico">${hudIcon("cron")}</span><span>Cron</span></button>
      <button data-tab="kanban" title="Local multi-agent coordination board with blockers, runs, and handoffs."><span class="nav-ico">${hudIcon("kanban")}</span><span>Kanban</span></button>
      <button data-tab="channels" title="Telegram / webhook channels the agent can deliver through."><span class="nav-ico">${hudIcon("channels")}</span><span>Channels</span></button>
      <button data-tab="agents" title="Specialists the propagation controller has spawned for repeated tasks."><span class="nav-ico">${hudIcon("agents")}</span><span>Agents</span></button>
      <button data-tab="nodes" title="Which machines are paired, which one is main, and who's online right now."><span class="nav-ico">${hudIcon("nodes")}</span><span>Nodes</span></button>

      <div class="nav-group-label">Diagnostics</div>
      <button data-tab="ops" title="Live operations — skill use, learning, edits, computer-use, vision, tools, and debug events."><span class="nav-ico">${hudIcon("ops")}</span><span>Ops</span></button>
      <button data-tab="today" title="What you got done today — completed tasks, skills run, actions approved, time tracked, themes."><span class="nav-ico">${hudIcon("today")}</span><span>Today</span></button>
      <button data-tab="activity" title="Ambient capture log — what you were doing on screen (if capture is enabled)."><span class="nav-ico">${hudIcon("activity")}</span><span>Activity</span></button>
      <button data-tab="computer-use" title="Computer use (beta) — every action the agent intended to take, with the reasoning it gave."><span class="nav-ico">${hudIcon("computer-use")}</span><span>Computer Use</span></button>
      <button data-tab="runs" title="Live tools, checks, QA screenshots, visual diffs, approvals, tokens, and rollback state without raw model reasoning."><span class="nav-ico">${hudIcon("runs")}</span><span>Runs</span></button>
      <button data-tab="budget" title="Today's LLM spend + 14-day history."><span class="nav-ico">${hudIcon("budget")}</span><span>Credits</span></button>
      <button data-tab="outcomes" title="Quality scores for completed agent work, 7d + 30d rolling."><span class="nav-ico">${hudIcon("outcomes")}</span><span>Outcomes</span></button>
      <button data-tab="health" title="Memory saturation, specialist health, MCP status, upcoming cron."><span class="nav-ico">${hudIcon("health")}</span><span>Health</span></button>
      <button data-tab="scrutiny" title="Directional Adaptive Scrutiny — the 7-axis scorer's calibration + recent verdicts."><span class="nav-ico">${hudIcon("scrutiny")}</span><span>Scrutiny</span></button>
    </nav>
    <div class="rail-footer">
      <div id="themeSwitch" role="group" aria-label="Interface theme">
        <span class="theme-label">Theme</span>
        <button class="theme-btn" data-theme="ares" title="TRON:ARES — emissive red over near-black" aria-label="TRON:ARES theme"></button>
        <button class="theme-btn" data-theme="cyberpunk" title="Cyberpunk — neon magenta / cyan duotone" aria-label="Cyberpunk theme"></button>
      </div>
      <div class="rail-gw">
        <button id="railUpdate" title="Pull the latest gateway code (git). Requires a restart to take effect."><span class="nav-ico">${hudIcon("update")}</span><span>Update</span></button>
        <button id="railRestart" title="Restart the gateway process. In-flight turns are dropped."><span class="nav-ico">${hudIcon("restart")}</span><span>Restart</span></button>
      </div>
      <div class="rail-gw-status" id="railGwResult"></div>
      <button id="setupBtn" title="Re-run the setup wizard or edit credentials"><span class="nav-ico">${hudIcon("setup")}</span><span>Setup</span></button>
    </div>
  </aside>
  <div class="content">
    <div class="topbar">
      <span id="status" class="status">connecting…</span>
    </div>
    <div class="body">
      <aside class="sidebar" id="sidebar">
        <header class="sub">
          <h2 id="sidebarTitle">Sessions</h2>
          <button class="add" id="newSession">+ New</button>
        </header>
        <ul id="sidebarList"></ul>
      </aside>
      <section class="main" id="main"></section>
    </div>
  </div>
</div>
<script>
const state = {
  tab: "chat",
  sessionId: null,
  sessions: [],
  agentId: "main",
  channel: "local",
  from: "browser",
  projectId: (() => {
    try { return localStorage.getItem("openagi.projectId") || "default"; }
    catch { return "default"; }
  })(),
  projects: [],
  projectDetail: null,
  messages: [],
  health: null,
  suggestionStatus: "pending",
  kanban: null,
  kanbanTaskId: null,
  runs: [],
  runKind: "",
  runSelected: null,
  ops: {
    events: [],
    filter: "all",
    paused: false,
    seeded: false,
    deferred: 0
  }
};

const $ = (id) => document.getElementById(id);
const main = $("main");
const sidebar = $("sidebar");
const sidebarList = $("sidebarList");
const sidebarTitle = $("sidebarTitle");
const newBtn = $("newSession");

document.querySelectorAll("nav button[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    switchTab(btn.dataset.tab);
  });
});
document.getElementById("setupBtn")?.addEventListener("click", () => {
  window.location.href = "/setup";
});

// ── Theme switcher ────────────────────────────────────────────────────
// Skins are pure CSS token overrides keyed off html[data-theme]; this just
// flips the attribute and persists the choice. "ares" is the shipped default
// (no override block), so a fresh load and a cleared preference look identical.
(() => {
  const KEY = "openagi.theme";
  const VALID = ["ares", "cyberpunk"];
  let theme = "ares";
  try { theme = localStorage.getItem(KEY) || "ares"; } catch {}
  if (!VALID.includes(theme)) theme = "ares";
  const apply = (t) => {
    document.documentElement.setAttribute("data-theme", t);
    document.querySelectorAll("#themeSwitch .theme-btn").forEach((b) => {
      const on = b.dataset.theme === t;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  };
  apply(theme);
  document.querySelectorAll("#themeSwitch .theme-btn").forEach((b) => {
    b.addEventListener("click", () => {
      theme = b.dataset.theme;
      apply(theme);
      try { localStorage.setItem(KEY, theme); } catch {}
    });
  });
})();

// ── Rail-footer gateway controls ──────────────────────────────────────
// Same /gateway/* routes the Models tab uses, surfaced globally so the
// operator never has to hunt for a restart. Restart stays disabled unless
// the daemon reports a supervisor (OPENAGI_SUPERVISED=1) — without one,
// exiting would stop the agent rather than cycle it.
(() => {
  const upd = document.getElementById("railUpdate");
  const rst = document.getElementById("railRestart");
  const out = document.getElementById("railGwResult");
  if (!upd || !rst || !out) return;

  const say = (msg) => { out.textContent = msg || ""; };
  const busy = (btn, on) => { btn.classList.toggle("busy", Boolean(on)); };

  // Gate Restart on supervisor presence, and keep the reason discoverable.
  fetchJson("/gateway/status", { projectScoped: false }).then((s) => {
    if (!s || s.supervised) return;
    rst.disabled = true;
    rst.title = "No process supervisor detected (OPENAGI_SUPERVISED=1). Exiting would stop the agent, not restart it.";
  }).catch(() => { /* status unavailable — leave enabled, POST still guards */ });

  upd.addEventListener("click", async () => {
    busy(upd, true);
    say("Pulling update…");
    try {
      const r = await postJson("/gateway/update", {});
      say(r.updated
        ? "Updated. Restart to run the new code."
        : "Already up to date.");
    } catch (e) {
      say("Update failed: " + e.message);
    } finally {
      busy(upd, false);
    }
  });

  rst.addEventListener("click", async () => {
    if (!confirm("Restart the gateway? In-flight turns will be dropped.")) return;
    busy(rst, true);
    say("Restarting…");
    try {
      await postJson("/gateway/restart", {});
      // The process exits mid-flight, so the socket drops by design. Poll
      // the new one rather than treating the dropped request as a failure.
      const waitForBoot = async (attempt) => {
        if (attempt > 40) {
          say("Gateway did not come back — check the service.");
          busy(rst, false);
          return;
        }
        try {
          const s = await fetchJson("/gateway/status", { projectScoped: false });
          say("Back up — pid " + s.pid + ".");
          busy(rst, false);
        } catch {
          setTimeout(() => waitForBoot(attempt + 1), 500);
        }
      };
      setTimeout(() => waitForBoot(0), 1200);
    } catch (e) {
      say("Restart refused: " + e.message);
      busy(rst, false);
    }
  });
})();

// Tiny markdown renderer for chat replies. No backtick characters in this
// function's source so it can live inside the dashboard's outer template
// literal without escaping wars. BT = backtick built from char code.
const BT = String.fromCharCode(96);
const FENCE = BT + BT + BT;
const FENCE_RE = new RegExp(FENCE + "(\\\\w+)?\\\\n([\\\\s\\\\S]*?)" + FENCE, "g");
const INLINE_RE = new RegExp(BT + "([^" + BT + "\\\\n]+)" + BT, "g");

function renderMarkdown(input) {
  if (!input) return "";
  let s = String(input);

  // Escape HTML first — guarantees XSS safety even if the renderer is buggy.
  s = s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

  // Fenced code blocks
  s = s.replace(FENCE_RE, (_, lang, code) => {
    const langClass = lang ? ' class="md-code-block lang-' + lang + '"' : ' class="md-code-block"';
    return '<pre class="md-code"><code' + langClass + '>' + code.replace(/\\n$/, "") + '</code></pre>';
  });

  // Inline code
  s = s.replace(INLINE_RE, '<code class="md-inline">$1</code>');

  // Headings
  s = s.replace(/^### (.*)$/gm, "<h4>$1</h4>");
  s = s.replace(/^## (.*)$/gm, "<h3>$1</h3>");
  s = s.replace(/^# (.*)$/gm, "<h2>$1</h2>");

  // Blockquotes
  s = s.replace(/^&gt; (.*)$/gm, "<blockquote>$1</blockquote>");

  // Bold then italic
  s = s.replace(/\\*\\*([^*\\n]+)\\*\\*/g, "<strong>$1</strong>");
  s = s.replace(/(?<!\\w)\\*([^*\\n]+?)\\*(?!\\w)/g, "<em>$1</em>");
  s = s.replace(/(?<!\\w)_([^_\\n]+?)_(?!\\w)/g, "<em>$1</em>");

  // Links [text](url)
  s = s.replace(/\\[([^\\]]+)\\]\\((https?:[^\\s)]+)\\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  // Lists
  const lines = s.split(/\\n/);
  const out = [];
  let ulOpen = false, olOpen = false;
  for (const line of lines) {
    const ulMatch = /^[-*] (.*)$/.exec(line);
    const olMatch = /^\\d+\\. (.*)$/.exec(line);
    if (ulMatch) {
      if (olOpen) { out.push("</ol>"); olOpen = false; }
      if (!ulOpen) { out.push("<ul>"); ulOpen = true; }
      out.push("<li>" + ulMatch[1] + "</li>");
    } else if (olMatch) {
      if (ulOpen) { out.push("</ul>"); ulOpen = false; }
      if (!olOpen) { out.push("<ol>"); olOpen = true; }
      out.push("<li>" + olMatch[1] + "</li>");
    } else {
      if (ulOpen) { out.push("</ul>"); ulOpen = false; }
      if (olOpen) { out.push("</ol>"); olOpen = false; }
      out.push(line);
    }
  }
  if (ulOpen) out.push("</ul>");
  if (olOpen) out.push("</ol>");
  s = out.join("\\n");

  // Paragraphs
  s = s.replace(/\\n{2,}/g, "</p><p>").replace(/\\n/g, "<br>");
  return "<p>" + s + "</p>";
}

// Small chat composer surface that any tab can embed at the top so the
// user can talk to the agent without leaving the structured view. The
// reply appears inline below the input; the optional onAfterSend hook
// re-runs the host tab's render to pick up state changes (e.g. a new
// task the agent just created via add_task).
function renderPageChatComposer(host, { placeholder = "Talk to your agent…", onAfterSend } = {}) {
  if (!host) return;
  host.innerHTML = \`
    <form class="page-chat" style="display:flex; gap:6px; margin-bottom:14px; align-items:flex-start;">
      <textarea class="page-chat-input" rows="1" placeholder="\${escapeHtml(placeholder)}" style="flex:1; min-width:200px; resize:vertical; padding:8px 10px; font:inherit;"></textarea>
      <button type="submit" class="page-chat-send">Send</button>
    </form>
    <div class="page-chat-reply" style="display:none;"></div>
  \`;
  const form = host.querySelector("form.page-chat");
  const input = host.querySelector(".page-chat-input");
  const sendBtn = host.querySelector(".page-chat-send");
  const reply = host.querySelector(".page-chat-reply");
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(180, input.scrollHeight) + "px";
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    reply.style.display = "block";
    reply.innerHTML = '<div class="muted" style="padding:10px 12px;">Thinking…</div>';
    try {
      const result = await postJson("/message", {
        text,
        channel: state.channel ?? "local",
        from: state.from ?? "browser",
        agentId: state.agentId,
        sessionId: state.sessionId
      });
      if (result.session?.id) state.sessionId = result.session.id;
      reply.innerHTML = \`
        <div class="card" style="padding:12px; margin-bottom:14px;">
          <div class="muted" style="font-size:11px; margin-bottom:6px;">openagi → \${escapeHtml(result.model?.model ?? "")}</div>
          <div>\${renderMarkdown(result.reply ?? "")}</div>
          <div style="margin-top:8px; font-size:11px;"><a href="/?tab=chat">continue in chat →</a></div>
        </div>
      \`;
      input.value = "";
      input.style.height = "auto";
      if (typeof onAfterSend === "function") {
        try { await onAfterSend(result); } catch { /* ignore */ }
      }
    } catch (err) {
      reply.innerHTML = \`<div class="card err" style="padding:10px 12px;">\${escapeHtml(err.message)}</div>\`;
    } finally {
      sendBtn.disabled = false;
    }
  });
}

function showToast(msg, ok = true) {
  // Stack toasts when multiple fire close together — the toast-stack
  // container is shared so they don't pile up at one position.
  let host = document.getElementById("toastStack");
  if (!host) {
    host = document.createElement("div");
    host.id = "toastStack";
    host.className = "ui-toast-stack";
    document.body.appendChild(host);
  }
  const t = document.createElement("div");
  t.className = "ui-toast " + (ok ? "ui-toast-ok" : "ui-toast-err");
  t.textContent = msg;
  host.appendChild(t);
  // Fade-out at 4s, remove at 4.5s so the transition has time.
  setTimeout(() => t.classList.add("ui-toast-leaving"), 4000);
  setTimeout(() => t.remove(), 4500);
}

/* Cerberus modal — the ref-05 "REBOOTING LASERS" pattern: a bordered,
   chamfered dialog with a pulsing title, a segmented progress bar, and a
   streaming monospace log beneath. Returns a handle:
     m.setProgress(0..1)  — fills the segmented bar
     m.log(text, cls)     — appends a log line (cls: "ln-ok" | "ln-dim")
     m.close()            — dismisses
   GPU-cheap (opacity/transform only) and reduced-motion safe. */
function cerbModal(title, segments = 12) {
  let overlay = document.getElementById("cerbModalOverlay");
  if (overlay) overlay.remove();
  overlay = document.createElement("div");
  overlay.id = "cerbModalOverlay";
  overlay.className = "cerb-modal-overlay open";
  const segs = Array.from({ length: segments }, () => '<span class="seg"></span>').join("");
  overlay.innerHTML =
    '<div class="cerb-modal" role="dialog" aria-modal="true">' +
      '<div class="cerb-modal-title">' + escapeHtml(title) + '</div>' +
      '<div class="cerb-progress">' + segs + '</div>' +
      '<div class="cerb-log"></div>' +
    '</div>';
  document.body.appendChild(overlay);
  const segEls = overlay.querySelectorAll(".cerb-progress .seg");
  const logEl = overlay.querySelector(".cerb-log");
  return {
    setProgress(frac) {
      const n = Math.round(Math.max(0, Math.min(1, frac)) * segEls.length);
      segEls.forEach((s, i) => s.classList.toggle("fill", i < n));
    },
    log(text, cls = "ln-dim") {
      const line = document.createElement("div");
      line.className = cls;
      line.textContent = text;
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
    },
    close() { overlay.remove(); },
    el: overlay,
  };
}

newBtn.addEventListener("click", async () => {
  if (state.tab === "chat") {
    if (state.sessionId) {
      try {
        const reset = await postJson("/sessions/reset", {
          sessionId: state.sessionId,
          channel: state.channel,
          from: state.from,
          agentId: state.agentId
        });
        state.sessionId = reset.sessionId ?? null;
      } catch {
        state.sessionId = null;
      }
    } else {
      state.sessionId = null;
    }
    state.messages = [];
    if (!state.sessionId) state.from = "browser-" + Date.now();
    renderTab();
  } else if (state.tab === "cron") {
    openCronComposer();
  } else if (state.tab === "kanban") {
    openKanbanComposer();
  } else if (state.tab === "projects") {
    openProjectComposer();
  } else if (state.tab === "skills") {
    // Triggers both miners (pattern + session) and shows scanned/found
    // counts so the user sees the system working even when nothing landed.
    const original = newBtn.textContent;
    newBtn.disabled = true;
    newBtn.textContent = "Mining…";
    try {
      const result = await postJson("/skills/mine", {});
      const p = result.pattern ?? {};
      const s = result.session ?? {};
      const totalNew = (p.candidates ?? 0) + (s.candidates ?? 0);
      const summary = totalNew > 0
        ? \`✨ \${totalNew} new candidate\${totalNew > 1 ? "s" : ""} — Pattern: \${p.candidates ?? 0}/\${p.mined ?? 0} · Session: \${s.candidates ?? 0}/\${s.mined ?? 0}\`
        : \`Mining done — Pattern: scanned \${p.mined ?? 0}, no new clusters · Session: scanned \${s.mined ?? 0}, no new clusters\`;
      showToast(summary, true);
      newBtn.textContent = totalNew > 0 ? \`✓ \${totalNew} new\` : "✓ Done";
      setTimeout(() => { newBtn.textContent = original; newBtn.disabled = false; }, 2400);
      await refreshSkills(true);
    } catch (err) {
      showToast("Mine failed: " + (err.message || String(err)), false);
      newBtn.textContent = "✗ Error";
      setTimeout(() => { newBtn.textContent = original; newBtn.disabled = false; }, 2400);
    }
  } else if (state.tab === "mcp") {
    openMcpComposer();
  }
});

async function switchTab(tab) {
  state.tab = tab;
  // The holo hero's WebGL loop only earns its frames on the Chat pane —
  // kill it the instant we navigate away (it restarts if Chat re-renders).
  cerbHoloStop();
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  const body = document.querySelector(".body");
  const showSidebar = (yes) => {
    sidebar.style.display = yes ? "" : "none";
    body.classList.toggle("no-sidebar", !yes);
  };

  if (tab === "chat") {
    showSidebar(true);
    sidebarTitle.textContent = "Sessions";
    newBtn.textContent = "+ New";
    await refreshSessions();
  } else if (tab === "cron") {
    showSidebar(true);
    sidebarTitle.textContent = "Schedules";
    newBtn.textContent = "+ Schedule";
    await refreshCron();
  } else if (tab === "kanban") {
    showSidebar(true);
    sidebarTitle.textContent = "Kanban";
    newBtn.textContent = "+ Task";
    await refreshKanban();
  } else if (tab === "projects") {
    showSidebar(true);
    sidebarTitle.textContent = "Projects";
    newBtn.textContent = "+ Project";
    await refreshProjects();
  } else if (tab === "skills") {
    showSidebar(true);
    sidebarTitle.textContent = "Skills";
    newBtn.textContent = "✨ Mine now";
    state.skillsMineButton = true;
    await refreshSkills();
  } else if (tab === "mcp") {
    showSidebar(true);
    sidebarTitle.textContent = "MCP Servers";
    newBtn.textContent = "+ Register";
    await refreshMcp();
  } else if (tab === "models") {
    showSidebar(false);
    await renderModels();
  } else if (tab === "agents") {
    showSidebar(false);
    await renderAgents();
  } else if (tab === "memory") {
    showSidebar(false);
    await renderMemory();
  } else if (tab === "nodes") {
    showSidebar(false);
    await renderNodes();
  } else if (tab === "channels") {
    showSidebar(false);
    await renderChannels();
  } else if (tab === "budget") {
    showSidebar(false);
    await renderBudget();
  } else if (tab === "outcomes") {
    showSidebar(false);
    await renderOutcomes();
  } else if (tab === "scrutiny") {
    showSidebar(false);
    await renderScrutiny();
  } else if (tab === "health") {
    showSidebar(false);
    await renderHealth();
  } else if (tab === "ops") {
    showSidebar(false);
    await renderOps();
  } else if (tab === "activity") {
    showSidebar(false);
    await renderActivity();
  } else if (tab === "runs") {
    showSidebar(false);
    await renderRuns();
  } else if (tab === "computer-use") {
    showSidebar(false);
    await renderComputerUse();
  } else if (tab === "today") {
    showSidebar(false);
    await renderToday();
  } else if (tab === "tasks") {
    showSidebar(false);
    await renderTasks();
  } else if (tab === "integrations") {
    showSidebar(false);
    await renderIntegrations();
  } else if (tab === "suggestions") {
    showSidebar(false);
    await renderSuggestions("pending");
  }
  renderTab();
  cerbMaterialise();
}

/* HUD "materialise" — replays the .cerb-in scanline-sweep + rise on the
   main pane every tab switch. The class is removed, a reflow is forced,
   then re-added so the animation restarts even on repeat visits to the
   same tab (otherwise it only plays once per page-load). Applied to the
   #main section so it covers every tab, including chat (which has no
   .pane wrapper). No-op under prefers-reduced-motion (CSS kills it). */
function cerbMaterialise() {
  const el = main;
  if (!el) return;
  el.classList.remove("cerb-in");
  void el.offsetWidth; // force reflow so the animation restarts
  el.classList.add("cerb-in");
}

function renderTab() {
  if (state.tab === "chat") return renderChat();
  // for other tabs, sidebar interaction drives main pane
}

async function refreshSessions() {
  const sessions = await fetchJson("/sessions");
  state.sessions = sessions;
  sidebarList.innerHTML = "";
  if (sessions.length === 0) {
    sidebarList.innerHTML = '<li class="empty">No sessions yet</li>';
  }
  for (const s of sessions) {
    const li = document.createElement("li");
    li.className = state.sessionId === s.id ? "active" : "";
    li.innerHTML = \`<div class="title">\${escapeHtml(s.id)}</div><div class="preview">\${escapeHtml(s.lastMessage || "")}</div>\`;
    li.addEventListener("click", () => loadSession(s.id));
    sidebarList.appendChild(li);
  }
}

async function refreshProjects() {
  const response = await fetchJson("/projects?archived=1", { projectScoped: false });
  state.projects = Array.isArray(response.projects) ? response.projects : [];
  const active = state.projects.filter((project) => project.status === "active");
  if (!active.some((project) => project.id === state.projectId)) {
    state.projectId = "default";
    try { localStorage.setItem("openagi.projectId", state.projectId); } catch {}
  }
  sidebarList.innerHTML = "";
  if (state.projects.length === 0) {
    sidebarList.innerHTML = '<li class="empty">No projects yet</li>';
    main.innerHTML = '<div class="empty">Create a project to begin.</div>';
    return;
  }
  for (const project of state.projects) {
    const li = document.createElement("li");
    li.className = state.projectDetail?.id === project.id ? "active" : "";
    const status = project.status === "archived"
      ? "archived"
      : project.id === state.projectId ? "selected" : "active";
    li.innerHTML = '<div class="title">' + escapeHtml(project.name)
      + '</div><div class="preview">' + escapeHtml(project.id + " - " + status) + '</div>';
    li.addEventListener("click", () => showProject(project.id));
    sidebarList.appendChild(li);
  }
  const requested = state.projectDetail?.id;
  const selected = state.projects.find((project) => project.id === requested)
    ?? state.projects.find((project) => project.id === state.projectId)
    ?? state.projects[0];
  showProject(selected.id, { refreshSidebar: false });
}

function showProject(projectId, { refreshSidebar = true } = {}) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  state.projectDetail = project;
  if (refreshSidebar) {
    for (const item of sidebarList.querySelectorAll("li")) item.classList.remove("active");
    const index = state.projects.findIndex((item) => item.id === projectId);
    if (index >= 0) sidebarList.children[index]?.classList.add("active");
  }
  const selected = project.id === state.projectId;
  const archived = project.status === "archived";
  const list = (values) => Array.isArray(values) && values.length
    ? values.map((value) => escapeHtml(value)).join(", ")
    : "none";
  main.innerHTML = [
    '<div class="card">',
    '<div class="row between"><div><div class="name">' + escapeHtml(project.name)
      + '</div><div class="muted">' + escapeHtml(project.id) + ' - revision '
      + escapeHtml(project.revision) + '</div></div>',
    '<span class="chip">' + escapeHtml(archived ? "archived" : selected ? "selected" : "active") + '</span></div>',
    '<p style="white-space:pre-wrap;">' + escapeHtml(project.instructions || "No project instructions.") + '</p>',
    '<div class="desc"><strong>Workspace</strong>: ' + escapeHtml(project.workspaceRoot) + '</div>',
    '<div class="desc"><strong>Memory</strong>: ' + escapeHtml(project.memoryScope) + '</div>',
    '<div class="desc"><strong>Tools</strong>: ' + list(project.policy?.allowedTools) + '</div>',
    '<div class="desc"><strong>Skills</strong>: ' + list(project.activeSkills) + '</div>',
    '<div class="desc"><strong>MCP grants</strong>: ' + list(project.mcpGrants) + '</div>',
    '<div class="desc"><strong>Secret references</strong>: ' + list(project.secretRefs) + '</div>',
    '<div class="row" style="margin-top:14px;">',
    archived ? '' : '<button id="projectSelectBtn"' + (selected ? ' disabled' : '') + '>Select</button>',
    archived ? '' : '<button id="projectEditBtn">Edit</button>',
    archived || project.id === "default" ? '' : '<button id="projectArchiveBtn" class="danger">Archive</button>',
    '</div></div>',
    // Live workspace surfaces for this project. The Artifact Canvas, durable
    // job runner, and recipe memory all shipped with full HTTP APIs but no
    // dashboard presence — these panels are their first visible surface.
    '<div class="grid stats" style="margin-top:16px;">',
    '<div class="card"><span class="desc">Artifacts</span><div class="stat-value" id="pwsArtifactCount">-</div></div>',
    '<div class="card"><span class="desc">Jobs</span><div class="stat-value" id="pwsJobCount">-</div></div>',
    '<div class="card"><span class="desc">Recipes</span><div class="stat-value" id="pwsRecipeCount">-</div></div>',
    '</div>',
    '<div class="hud-label" style="margin-top:18px;">// WORKSPACE SURFACES</div>',
    '<div class="grid" id="projectWorkspaceSurfaces"></div>'
  ].join("");
  document.getElementById("projectSelectBtn")?.addEventListener("click", () => selectProject(project));
  document.getElementById("projectEditBtn")?.addEventListener("click", () => openProjectEditor(project));
  document.getElementById("projectArchiveBtn")?.addEventListener("click", () => archiveProject(project));
  renderProjectWorkspaceSurfaces(project.id);
}

// Artifact Canvas / durable jobs / recipe memory, rendered inline on the
// project they belong to. Each surface is optional at runtime (the feature can
// be disabled, in which case its route answers 503) so every panel degrades to
// a quiet "unavailable" card instead of blanking the whole tab.
async function renderProjectWorkspaceSurfaces(projectId) {
  const host = document.getElementById("projectWorkspaceSurfaces");
  if (!host) return;
  const panels = [
    {
      key: "artifacts",
      title: "Artifact Canvas",
      note: "Versioned markdown + data artifacts.",
      countEl: "pwsArtifactCount",
      load: async () => {
        const rows = await fetchJson("/artifacts?limit=8");
        return Array.isArray(rows) ? rows : [];
      },
      row: (a) => ({
        name: a.title || a.id,
        meta: [a.kind, "rev " + a.revision, relTime(a.updatedAt)].filter(Boolean).join(" - "),
        badge: "v" + a.revision
      })
    },
    {
      key: "jobs",
      title: "Durable jobs",
      note: "Policy-aware background work; survives restart.",
      countEl: "pwsJobCount",
      load: async () => {
        const body = await fetchJson("/jobs?limit=8");
        return Array.isArray(body.jobs) ? body.jobs : [];
      },
      row: (j) => ({
        name: j.target || j.kind || j.id,
        meta: [j.kind, "attempt " + (j.attempt ?? 0) + "/" + (j.maxAttempts ?? 0), relTime(j.updatedAt)]
          .filter(Boolean).join(" - "),
        badge: j.status,
        badgeClass: j.status === "succeeded" ? "ok"
          : j.status === "failed" || j.status === "cancelled" ? "err"
          : "warn"
      })
    },
    {
      key: "recipes",
      title: "Recipe memory",
      note: "Verified procedures promoted from real runs.",
      countEl: "pwsRecipeCount",
      load: async () => {
        const body = await fetchJson("/recipes?limit=8");
        return Array.isArray(body.items) ? body.items : [];
      },
      row: (r) => ({
        name: r.title || r.id,
        meta: [r.summary, relTime(r.updatedAt ?? r.createdAt)].filter(Boolean).join(" - "),
        badge: r.status,
        badgeClass: r.status === "verified" ? "ok"
          : r.status === "failed" ? "err"
          : ""
      })
    }
  ];

  host.innerHTML = panels
    .map((panel) => '<div class="card" id="pws-' + panel.key + '">'
      + '<div class="row between"><span class="name">' + escapeHtml(panel.title) + '</span>'
      + '<span class="chip">loading</span></div>'
      + '<div class="desc">' + escapeHtml(panel.note) + '</div></div>')
    .join("");

  for (const panel of panels) {
    const card = document.getElementById("pws-" + panel.key);
    if (!card) continue;
    try {
      const items = await panel.load();
      const counter = document.getElementById(panel.countEl);
      if (counter) counter.textContent = String(items.length);
      const body = items.length === 0
        ? '<div class="desc">Nothing yet.</div>'
        : items.map((item) => {
            const view = panel.row(item);
            const badge = view.badge
              ? '<span class="badge ' + escapeHtml(view.badgeClass ?? "") + '">'
                + escapeHtml(view.badge) + '</span>'
              : "";
            return '<div class="row between" style="padding:6px 0;border-top:1px solid var(--line);">'
              + '<span>' + escapeHtml(view.name) + '</span>' + badge + '</div>'
              + '<div class="desc">' + escapeHtml(view.meta) + '</div>';
          }).join("");
      card.innerHTML = '<div class="row between"><span class="name">' + escapeHtml(panel.title) + '</span>'
        + '<span class="chip">' + items.length + '</span></div>'
        + '<div class="desc">' + escapeHtml(panel.note) + '</div>'
        + body;
    } catch (error) {
      const counter = document.getElementById(panel.countEl);
      if (counter) counter.textContent = "-";
      card.innerHTML = '<div class="row between"><span class="name">' + escapeHtml(panel.title) + '</span>'
        + '<span class="chip">unavailable</span></div>'
        + '<div class="desc">' + escapeHtml(error.message || "Surface unavailable.") + '</div>';
    }
  }
}

// Compact relative timestamp for HUD rows ("3m", "2h", "5d").
function relTime(value) {
  if (!value) return "";
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return "";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return secs + "s";
  if (secs < 3600) return Math.round(secs / 60) + "m";
  if (secs < 86400) return Math.round(secs / 3600) + "h";
  return Math.round(secs / 86400) + "d";
}

function openProjectComposer() {
  state.projectDetail = null;
  main.innerHTML = [
    '<form id="projectCreateForm" class="card">',
    '<div class="name">Create project</div>',
    '<label>Name<input id="projectName" required maxlength="200" placeholder="Release workspace"></label>',
    '<label>Project ID<input id="projectId" maxlength="64" pattern="[a-z0-9][a-z0-9_-]*" placeholder="generated-from-name"></label>',
    '<label>Instructions<textarea id="projectInstructions" maxlength="32000" rows="7" placeholder="Project-specific goals and constraints"></textarea></label>',
    '<button type="submit">Create project</button>',
    '</form>'
  ].join("");
  document.getElementById("projectCreateForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = {
      name: document.getElementById("projectName").value.trim(),
      instructions: document.getElementById("projectInstructions").value
    };
    const id = document.getElementById("projectId").value.trim();
    if (id) body.id = id;
    try {
      const project = await postJson("/projects", body, { projectScoped: false });
      showToast("Project created.");
      await refreshProjects();
      showProject(project.id);
    } catch (error) {
      showToast("Project creation failed: " + error.message, false);
    }
  });
}

function openProjectEditor(project) {
  const value = (items) => Array.isArray(items) ? items.join(", ") : "";
  main.innerHTML = [
    '<form id="projectEditForm" class="card">',
    '<div class="name">Edit ' + escapeHtml(project.name) + '</div>',
    '<label>Name<input id="projectEditName" required maxlength="200" value="' + escapeHtml(project.name) + '"></label>',
    '<label>Instructions<textarea id="projectEditInstructions" maxlength="32000" rows="7">' + escapeHtml(project.instructions || "") + '</textarea></label>',
    '<label>Allowed tools<input id="projectEditTools" value="' + escapeHtml(value(project.policy?.allowedTools)) + '" placeholder="tool_name, prefix_*"></label>',
    '<label>Active skills<input id="projectEditSkills" value="' + escapeHtml(value(project.activeSkills)) + '" placeholder="skill-name"></label>',
    '<label>MCP grants<input id="projectEditMcp" value="' + escapeHtml(value(project.mcpGrants)) + '" placeholder="server-name"></label>',
    '<label>Secret references<input id="projectEditSecrets" value="' + escapeHtml(value(project.secretRefs)) + '" placeholder="SECRET_NAME"></label>',
    '<div class="row"><button type="submit">Save</button><button id="projectEditCancel" type="button">Cancel</button></div>',
    '</form>'
  ].join("");
  const split = (id) => document.getElementById(id).value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  document.getElementById("projectEditCancel").addEventListener("click", () => showProject(project.id));
  document.getElementById("projectEditForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const updated = await patchJson("/projects/" + encodeURIComponent(project.id), {
        expectedRevision: project.revision,
        patch: {
          name: document.getElementById("projectEditName").value.trim(),
          instructions: document.getElementById("projectEditInstructions").value,
          policy: {
            ...(project.policy ?? {}),
            allowedTools: split("projectEditTools")
          },
          activeSkills: split("projectEditSkills"),
          mcpGrants: split("projectEditMcp"),
          secretRefs: split("projectEditSecrets")
        }
      }, { projectScoped: false });
      showToast("Project updated.");
      await refreshProjects();
      showProject(updated.id);
    } catch (error) {
      showToast("Project update failed: " + error.message, false);
    }
  });
}

async function selectProject(project) {
  try {
    await postJson("/projects/" + encodeURIComponent(project.id) + "/select", {}, {
      projectScoped: false
    });
    state.projectId = project.id;
    state.sessionId = null;
    state.messages = [];
    try { localStorage.setItem("openagi.projectId", state.projectId); } catch {}
    window.location.href = "/?tab=projects";
  } catch (error) {
    showToast("Project selection failed: " + error.message, false);
  }
}

async function archiveProject(project) {
  if (!confirm("Archive project '" + project.name + "'? Existing data is retained.")) return;
  try {
    await postJson("/projects/" + encodeURIComponent(project.id) + "/archive", {
      expectedRevision: project.revision
    }, { projectScoped: false });
    showToast("Project archived.");
    if (state.projectId === project.id) {
      state.projectId = "default";
      try { localStorage.setItem("openagi.projectId", state.projectId); } catch {}
    }
    await refreshProjects();
  } catch (error) {
    showToast("Project archive failed: " + error.message, false);
  }
}

async function loadSession(id) {
  state.sessionId = id;
  const session = await fetchJson("/sessions/" + encodeURIComponent(id));
  state.messages = session.messages ?? [];
  state.channel = state.messages[0]?.channel ?? "local";
  state.from = state.messages[0]?.from ?? "browser";
  await refreshSessions();
  renderChat();
}

function renderChat() {
  main.innerHTML = \`
    <div id="chat-deeplink" style="margin-bottom:8px;"></div>
    <div class="thread" id="thread"></div>
    <form class="composer" id="composer">
      <textarea id="input" placeholder="Message your Cerberus agent…" rows="1"></textarea>
      <button type="submit" id="send">Send</button>
    </form>
  \`;
  const thread = $("thread");
  if (state.messages.length === 0) {
    // First-run welcome card: when this user has never had any session
    // (just landed from /setup) and hasn't dismissed before, show the
    // 4 things worth doing next. localStorage dismiss persists across
    // sessions in the same browser; after the first real session exists,
    // we fall back to the lighter prompt automatically.
    const noSessions = (state.sessions ?? []).length === 0;
    let dismissed = false;
    try { dismissed = localStorage.getItem("openagi.welcomeDismissed") === "1"; } catch { /* ignore */ }
    thread.innerHTML = (noSessions && !dismissed) ? renderFirstRunWelcome() : renderChatEmpty();
    // Bring up the holographic projection if the empty-state emitter is
    // present (no-op otherwise). The GL loop self-caps to this pane.
    cerbHoloStart();
  }
  for (const m of state.messages) appendMessage(m, false);
  thread.scrollTop = thread.scrollHeight;
  // Render a deep-link panel above the thread when the user arrived
  // here via a notification with ?suggestion=<id> or ?pending=<id>.
  // The panel is the in-chat surface for proactive suggestions and
  // agent-action approvals — clicking buttons here calls the same
  // backend endpoints the Suggestions tab does.
  renderChatDeepLink();
  // First-run welcome card click routing. Each card has a data-welcome-target
  // saying where it should send the user. Dismiss persists in localStorage
  // so it doesn't reappear next session.
  document.querySelectorAll("[data-welcome-target]").forEach((card) => {
    card.addEventListener("click", () => {
      const target = card.dataset.welcomeTarget;
      if (target === "integrations") switchTab("integrations");
      else if (target === "tasks") switchTab("tasks");
      else if (target === "capture") {
        showToast("Open the menu bar icon → Capture → Enable to turn on screen observation.", true);
      } else if (target === "chat-self") {
        const inp = $("input");
        if (inp) { inp.value = "What can you do?"; inp.focus(); inp.dispatchEvent(new Event("input")); }
      }
    });
  });
  document.getElementById("dismissWelcome")?.addEventListener("click", () => {
    try { localStorage.setItem("openagi.welcomeDismissed", "1"); } catch { /* ignore */ }
    const thread = $("thread");
    if (thread) thread.innerHTML = renderChatPlaceholder();
  });
  const input = $("input");
  // ?compose=<intent> seeds the input with a starter sentence so the user
  // can finish typing and Enter — agent picks up via add_task /
  // connect_catalog_mcp / etc tools. Used by the menu-bar "+ Add task"
  // button so its click drops you straight into a conversation rather
  // than a structured form.
  const composeIntent = new URLSearchParams(window.location.search).get("compose");
  if (composeIntent && state.messages.length === 0) {
    const seed = ({
      "add-task": "Add a task: ",
      "add-mcp": "Connect this MCP: ",
      "schedule": "Remind me to ",
      "remember": "Remember that "
    })[composeIntent];
    if (seed) {
      input.value = seed;
      input.dispatchEvent(new Event("input"));
      // Move caret to end so the user starts typing in the right spot.
      requestAnimationFrame(() => {
        input.setSelectionRange(seed.length, seed.length);
      });
      // Strip the query so reload / re-render doesn't re-seed.
      const url = new URL(window.location.href);
      url.searchParams.delete("compose");
      history.replaceState(null, "", url.toString());
    }
  }
  input.focus();
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(200, input.scrollHeight) + "px";
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });
  $("composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    input.style.height = "auto";
    appendMessage({ role: "user", content: text, from: state.from, channel: state.channel, createdAt: new Date().toISOString() });
    const sendBtn = $("send");
    sendBtn.disabled = true;
    // The avatar reacts to the harness working — spin it up while we wait.
    if (window.cerbHoloReact) window.cerbHoloReact("thinking");
    if (window.cerbPetReact) window.cerbPetReact("thinking");
    try {
      const result = await postJson("/message", {
        text,
        channel: state.channel,
        from: state.from,
        agentId: state.agentId,
        sessionId: state.sessionId
      });
      state.sessionId = result.session.id;
      appendMessage({ role: "assistant", content: result.reply, from: "openagi", channel: state.channel, createdAt: result.createdAt, metadata: result.model });
      refreshSessions();
      if (window.cerbPetSetState) window.cerbPetSetState("jumping");   // happy hop on reply
    } catch (err) {
      appendMessage({ role: "assistant", content: "[error] " + err.message });
      if (window.cerbPetReact) window.cerbPetReact("offline");          // sad droop on error
    } finally {
      sendBtn.disabled = false;
    }
  });
}

async function renderChatDeepLink() {
  const host = document.getElementById("chat-deeplink");
  if (!host) return;
  const qs = new URLSearchParams(window.location.search);
  const suggestionId = qs.get("suggestion");
  const pendingId = qs.get("pending");
  if (!suggestionId && !pendingId) {
    host.innerHTML = "";
    return;
  }
  // Loading shimmer while we fetch.
  host.innerHTML = '<div class="card" style="padding:12px;"><span class="muted">Loading…</span></div>';
  try {
    if (suggestionId) {
      const all = await fetchJson("/proactive/suggestions").catch(() => []);
      const sug = Array.isArray(all) ? all.find((s) => s.id === suggestionId) : null;
      if (!sug || sug.status !== "pending") {
        host.innerHTML = \`<div class="card" style="padding:10px 14px;"><span class="muted">This suggestion has already been \${escapeHtml(sug?.status ?? "removed")}.</span></div>\`;
        return;
      }
      const icon = ({ task: "📋", skill: "✨", mcp: "🔌", automation: "⚙️", knowledge: "💡" })[sug.category] ?? "🔔";
      host.innerHTML = \`
        <div class="card" style="padding:14px;">
          <div style="display:flex; gap:8px; align-items:center;">
            <span style="font-size:18px;">\${icon}</span>
            <span style="font-weight:600;">\${escapeHtml(sug.title || "Cerberus noticed something")}</span>
            <span class="badge">\${escapeHtml(sug.category || "fyi")}</span>
          </div>
          <div class="muted" style="margin-top:6px; font-size:12px;">\${escapeHtml(sug.rationale || "")}</div>
          <div class="row" style="gap:8px; margin-top:10px;">
            <button id="dl-accept">Accept</button>
            <button id="dl-dismiss" class="secondary">Dismiss</button>
            <button id="dl-reject" class="secondary">Reject</button>
          </div>
        </div>
      \`;
      const handle = async (action) => {
        try {
          const res = await postJson(\`/proactive/suggestions/\${encodeURIComponent(suggestionId)}/\${action}\`, {});
          if (action === "accept" && res.taskId) {
            showToast("✓ Task added — opening Tasks", true);
            setTimeout(() => switchTab("tasks"), 600);
          } else if (action === "accept" && res.registered) {
            showToast(\`✓ MCP \${res.registered} connected — opening MCP tab\`, true);
            setTimeout(() => switchTab("mcp"), 600);
          } else {
            showToast(\`Suggestion \${action}d\`, true);
          }
          host.innerHTML = "";
          // Strip the suggestion query so reload doesn't re-render the card.
          const url = new URL(window.location.href);
          url.searchParams.delete("suggestion");
          history.replaceState(null, "", url.toString());
        } catch (err) {
          showToast(\`\${action} failed: \${err.message}\`, false);
        }
      };
      document.getElementById("dl-accept").addEventListener("click", () => handle("accept"));
      document.getElementById("dl-dismiss").addEventListener("click", () => handle("dismiss"));
      document.getElementById("dl-reject").addEventListener("click", () => handle("reject"));
    } else if (pendingId) {
      const list = await fetchJson("/pending-actions").catch(() => ({ actions: [] }));
      const action = (list.actions ?? []).find((a) => a.id === pendingId);
      if (!action || action.status !== "pending") {
        host.innerHTML = \`<div class="card" style="padding:10px 14px;"><span class="muted">This agent action has already been \${escapeHtml(action?.status ?? "removed")}.</span></div>\`;
        return;
      }
      host.innerHTML = \`
        <div class="card" style="padding:14px;">
          <div style="display:flex; gap:8px; align-items:center;">
            <span style="font-size:18px;">🤖</span>
            <span style="font-weight:600;">\${escapeHtml(action.summary || action.toolName)}</span>
            <span class="badge">\${escapeHtml(action.toolName)}</span>
          </div>
          \${action.reason ? \`<div class="muted" style="margin-top:6px; font-size:12px;">\${escapeHtml(action.reason)}</div>\` : ""}
          <details open style="margin-top:6px;"><summary class="muted" style="font-size:11px;">args</summary><pre style="font-size:11px; margin-top:4px;">\${escapeHtml(JSON.stringify(action.args, null, 2))}</pre></details>
          <div class="row" style="gap:8px; margin-top:10px;">
            <button id="dl-approve">Approve & run</button>
            <button id="dl-deny" class="secondary">Deny</button>
          </div>
        </div>
      \`;
      const handle = async (decision) => {
        try {
          const res = await postJson(\`/pending-actions/\${encodeURIComponent(pendingId)}/\${decision}\`, {});
          const summary = res?.result?.note ?? res?.result?.message ?? \`Action \${decision}d.\`;
          showToast(\`✓ \${summary}\`, true);
          host.innerHTML = "";
          const url = new URL(window.location.href);
          url.searchParams.delete("pending");
          history.replaceState(null, "", url.toString());
        } catch (err) {
          showToast(\`\${decision} failed: \${err.message}\`, false);
        }
      };
      document.getElementById("dl-approve").addEventListener("click", () => handle("approve"));
      document.getElementById("dl-deny").addEventListener("click", () => handle("deny"));
    }
  } catch (err) {
    host.innerHTML = \`<div class="card" style="padding:10px 14px;"><span class="err">Failed to load: \${escapeHtml(err.message)}</span></div>\`;
  }
}

function renderChatPlaceholder() {
  // Lighter prompt shown after the first session exists — assumes the
  // user knows what kind of thing they can say. Kept terse on purpose.
  return '<div class="ui-empty" style="margin: var(--space-4) 0;">Start a new conversation. Try "Remind me in 60 seconds to drink water" or "Remember that my standup is 9am Mondays".</div>';
}

function renderChatEmpty() {
  // Empty chat pane = the holographic emitter (ref-02 volumetric hero):
  // a raw-WebGL wireframe of the three-wolf mark floating over a grid
  // plane, wrapped in HUD chrome, with the one-line prompt beneath it.
  // The GL loop is hard-capped in cerbHoloStart (Chat-only, visible-only,
  // single static frame under prefers-reduced-motion).
  return (
    '<div class="holo-hero" id="holoHero">' +
      '<canvas id="holoCanvas" width="620" height="300" aria-hidden="true"></canvas>' +
      '<div class="holo-cap">Cerberus // Holo-Projection 03</div>' +
      '<div class="holo-status" id="holoStatus">Projecting</div>' +
    '</div>' +
    renderChatPlaceholder()
  );
}

/* ─── Holo hero engine — raw WebGL, zero deps, hard-capped ──────────────
   Draws the Cerberus mark as an extruded 3D wireframe (line segments)
   over a perspective grid floor, additively blended for the emissive
   hologram look. The render loop is deliberately throttled:
     • runs only while the Chat tab is active,
     • pauses on document.hidden,
     • renders ONE static frame under prefers-reduced-motion,
     • tears itself down when the canvas leaves the DOM.
   Azazel's dashboard sits open for hours — this must not tax the GPU. */

let cerbHoloRaf = 0;
let cerbHoloLive = false;

function cerbHoloStop() {
  cerbHoloLive = false;
  if (cerbHoloRaf) { cancelAnimationFrame(cerbHoloRaf); cerbHoloRaf = 0; }
}

/* ─── Holo avatar — geometry ────────────────────────────────────────────
   The avatar is built from layered primitives that share ONE source of
   truth (the Cerberus mark polylines — the same geometry as cerbMarkSVG,
   so the brand mark and the projection are literally the same shape):
     1. an extruded wireframe "skeleton" (front ring, back ring, struts),
     2. a volumetric particle field sampled from the mark's strokes — the
        img2threejs technique: rasterise the glyph, then turn every lit
        pixel into a particle whose depth comes from its brightness, so
        the strokes read as a shallow relief instead of a flat outline,
     3. two counter-rotating orbital rings for the "projection" feel.
   All of it is raw WebGL line/point primitives — zero dependencies. */

/* Single source of truth for the mark's polylines (64x64 mark space). */
function cerbMarkPolys() {
  const W = 64;
  const mir = (pts) => pts.map((p) => [W - p[0], p[1]]);
  const sideHead = [[0,20],[10,15],[11,14],[13,6],[16,12],[20,14],[19,20],[18,25],[11,27],[5,25],[0,23]];
  return [
    { pts: sideHead, closed: true },
    { pts: [[10,19],[13,18]], closed: false },
    { pts: [[9,16],[13,15]], closed: false },
    { pts: [[2,22],[8,23]], closed: false },
    { pts: mir(sideHead), closed: true },
    { pts: mir([[10,19],[13,18]]), closed: false },
    { pts: mir([[9,16],[13,15]]), closed: false },
    { pts: mir([[2,22],[8,23]]), closed: false },
    { pts: [[21,4],[26,13],[32,11],[38,13],[43,4],[44,15],[42,25],[37,33],[32,40],[27,33],[22,25],[20,15]], closed: true },
    { pts: [[27,17],[32,19],[37,17]], closed: false },
    { pts: [[26,22],[29,24]], closed: false },
    { pts: [[38,22],[35,24]], closed: false },
    { pts: [[30,30],[34,30],[32,33]], closed: true },
  ];
}

function cerbHoloGeometry() {
  const D = 3;
  const v = (x, y, z) => [(x - 32) / 32, (32 - y) / 32, z / 32];
  const segs = [];
  const push = (a, b) => { segs.push(a[0], a[1], a[2], b[0], b[1], b[2]); };
  for (const poly of cerbMarkPolys()) {
    const n = poly.pts.length;
    const front = poly.pts.map((p) => v(p[0], p[1], D));
    const back = poly.pts.map((p) => v(p[0], p[1], -D));
    const last = poly.closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const j = (i + 1) % n;
      push(front[i], front[j]);
      push(back[i], back[j]);
    }
    for (let i = 0; i < n; i++) push(front[i], back[i]);
  }
  return new Float32Array(segs);
}

/* Volumetric particle field — the img2threejs technique applied to our own
   mark: rasterise the glyph to an offscreen canvas, then turn every lit
   pixel into a particle. Brightness drives depth, so the strokes read as
   a shallow relief; three depth layers + deterministic jitter give volume. */
function cerbHoloPointCloud() {
  const S = 128;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const ctx = c.getContext("2d");
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 3.0;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const scale = S / 64;
  for (const poly of cerbMarkPolys()) {
    ctx.beginPath();
    poly.pts.forEach((p, i) => {
      const x = p[0] * scale, y = p[1] * scale;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    if (poly.closed) ctx.closePath();
    ctx.stroke();
  }
  const img = ctx.getImageData(0, 0, S, S).data;
  const rand = mulberry32(1337);
  const pts = [];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const a = img[(y * S + x) * 4 + 3];
      if (a < 30) continue;
      const bright = a / 255;
      const px = (x - S / 2) / (S / 2);
      const py = (S / 2 - y) / (S / 2);
      for (let layer = 0; layer < 5; layer++) {
        const z = ((layer / 4) - 0.5) * 0.26 + (bright - 0.5) * 0.12;
        pts.push(
          px + (rand() - 0.5) * 0.010,
          py + (rand() - 0.5) * 0.010,
          z + (rand() - 0.5) * 0.02
        );
      }
    }
  }
  return new Float32Array(pts);
}

/* Tiny deterministic PRNG so particle jitter is stable frame-to-frame. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Orbital ring — a circle of line segments in the XZ plane. */
function cerbRingGeometry(radius, segments = 64) {
  const segs = [];
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    segs.push(Math.cos(a0) * radius, 0, Math.sin(a0) * radius);
    segs.push(Math.cos(a1) * radius, 0, Math.sin(a1) * radius);
  }
  return new Float32Array(segs);
}

/* Projector light cone — fans up from the emitter point on the grid
   to the top of the projection volume, selling the "emitted" fiction. */
function cerbConeGeometry(segments = 24) {
  const segs = [];
  const apexY = -0.95, topY = 0.7, topR = 1.1;
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    segs.push(0, apexY, 0);
    segs.push(Math.cos(a) * topR, topY, Math.sin(a) * topR);
  }
  return new Float32Array(segs);
}

/* Perspective grid floor beneath the projection. */
function cerbGridGeometry() {
  const segs = [];
  const S = 2.6, step = 0.4, y = -0.95;
  const push = (a, b) => { segs.push(a[0], a[1], a[2], b[0], b[1], b[2]); };
  for (let x = -S; x <= S + 1e-9; x += step) push([x, y, -S], [x, y, S]);
  for (let z = -S; z <= S + 1e-9; z += step) push([-S, y, z], [S, y, z]);
  return new Float32Array(segs);
}

/* ─── Holo avatar — reactive state ──────────────────────────────────────
   The avatar mirrors whatever the harness is doing. cerbHoloReact(mode) is
   the single entry point; the render loop smooths "energy" toward the
   mode's target so transitions feel analog, not snapped. Energy drives
   rotation speed, pulse rate, particle twinkle, ring brightness, jitter. */
const cerbHoloState = {
  mode: "idle",       // idle | thinking | offline
  energy: 0.3,        // smoothed 0..1
  target: 0.3,
  online: true,
};
window.cerbHoloReact = function (mode) {
  cerbHoloState.mode = mode;
  cerbHoloState.target = mode === "thinking" ? 1.0 : mode === "offline" ? 0.08 : 0.3;
  cerbHoloState.online = mode !== "offline";
  // Keep the emitter readout honest — don't claim "Projecting" while offline.
  const status = document.getElementById("holoStatus");
  if (status) status.textContent = mode === "offline" ? "Standby" : mode === "thinking" ? "Processing" : "Projecting";
};

/* Poll the daemon's public /health so the avatar tracks agent liveness. */
(function cerbHoloHealthWatch() {
  let petWasOffline = false;
  const check = () => {
    fetch("/health").then((r) => r.json()).then((h) => {
      const up = Boolean(h && h.ok);
      if (up && cerbHoloState.mode === "offline") window.cerbHoloReact("idle");
      else if (!up && cerbHoloState.mode !== "offline") window.cerbHoloReact("offline");
      // The pet mirrors daemon liveness too — droop when down, recover when up.
      if (window.cerbPetReact) {
        if (!up) { window.cerbPetReact("offline"); petWasOffline = true; }
        else if (petWasOffline) { window.cerbPetReact("online"); petWasOffline = false; }
      }
    }).catch(() => { if (cerbHoloState.mode !== "offline") window.cerbHoloReact("offline"); });
  };
  check();
  setInterval(check, 5000);
})();

/* Minimal column-major mat4 helpers (no library). */
function mPersp(fov, aspect, near, far) {
  const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0,  0, f, 0, 0,  0, 0, (far + near) * nf, -1,  0, 0, 2 * far * near * nf, 0];
}
function mMul(a, b) {
  const o = [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0];
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++)
        o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function mRotY(a) { const c = Math.cos(a), s = Math.sin(a); return [c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]; }
function mRotX(a) { const c = Math.cos(a), s = Math.sin(a); return [1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]; }
function mTrans(x, y, z) { return [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1]; }
function mScale(s) { return [s,0,0,0, 0,s,0,0, 0,0,s,0, 0,0,0,1]; }
function mScaleY(s) { return [1,0,0,0, 0,s,0,0, 0,0,1,0, 0,0,0,1]; }

function cerbHoloStart() {
  const canvas = document.getElementById("holoCanvas");
  if (!canvas || cerbHoloLive) return;
  const gl = canvas.getContext("webgl", { antialias: true, alpha: false, powerPreference: "low-power" });
  const status = document.getElementById("holoStatus");
  if (!gl) { if (status) status.textContent = "No signal"; return; }

  // Line program (wireframe skeleton, rings, grid).
  const lineVs = "attribute vec3 p;uniform mat4 mvp;void main(){gl_Position=mvp*vec4(p,1.0);}";
  const lineFs = "precision mediump float;uniform vec3 col;uniform float alpha;void main(){gl_FragColor=vec4(col,alpha);}";
  // Point program (volumetric particle field) — per-particle phase twinkle.
  const pointVs = "attribute vec3 p;attribute float ph;uniform mat4 mvp;uniform float time;uniform float energy;uniform float size;varying float vTw;varying float vDepth;void main(){vec4 clip=mvp*vec4(p,1.0);gl_Position=clip;float depth=clip.w;vDepth=clamp(1.0-(depth-3.1)/0.6,0.15,1.0);vTw=0.55+0.45*sin(time*(1.2+energy*3.5)+ph);gl_PointSize=size*(0.6+0.4*vTw)*(1.0+energy*0.6)*(0.6+0.5*vDepth);}";
  const pointFs = "precision highp float;uniform vec3 col;uniform float alpha;uniform float time;varying float vTw;varying float vDepth;void main(){vec2 uv=gl_PointCoord-0.5;float d=length(uv);float fall=smoothstep(0.5,0.05,d);float flick=0.92+0.08*sin(time*23.0+gl_FragCoord.x*0.7);gl_FragColor=vec4(col,alpha*fall*vTw*(0.5+0.5*vDepth)*flick);}";

  const compile = (type, s) => { const sh = gl.createShader(type); gl.shaderSource(sh, s); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) console.warn("[holo] shader:", gl.getShaderInfoLog(sh)); return sh; };
  const link = (vs, fs) => { const p = gl.createProgram(); gl.attachShader(p, compile(gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) console.warn("[holo] link:", gl.getProgramInfoLog(p)); return p; };

  const lineProg = link(lineVs, lineFs);
  const pointProg = link(pointVs, pointFs);

  const lP = gl.getAttribLocation(lineProg, "p");
  const lMvp = gl.getUniformLocation(lineProg, "mvp");
  const lCol = gl.getUniformLocation(lineProg, "col");
  const lAlpha = gl.getUniformLocation(lineProg, "alpha");
  const pP = gl.getAttribLocation(pointProg, "p");
  const pPh = gl.getAttribLocation(pointProg, "ph");
  const pMvp = gl.getUniformLocation(pointProg, "mvp");
  const pCol = gl.getUniformLocation(pointProg, "col");
  const pAlpha = gl.getUniformLocation(pointProg, "alpha");
  const pTime = gl.getUniformLocation(pointProg, "time");
  const pEnergy = gl.getUniformLocation(pointProg, "energy");
  const pSize = gl.getUniformLocation(pointProg, "size");

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // additive — emissive hologram
  gl.clearColor(0.012, 0.012, 0.014, 1.0);

  const makeBuf = (data) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return { buf: b, count: data.length / 3 }; };

  const markBuf = makeBuf(cerbHoloGeometry());
  const gridBuf = makeBuf(cerbGridGeometry());
  const ring1 = makeBuf(cerbRingGeometry(1.35));
  const ring2 = makeBuf(cerbRingGeometry(1.6));
  const coneBuf = makeBuf(cerbConeGeometry());

  // Point cloud + a per-particle phase attribute for twinkle.
  const pcData = cerbHoloPointCloud();
  const pcCount = pcData.length / 3;
  const phases = new Float32Array(pcCount);
  const prand = mulberry32(42);
  for (let i = 0; i < pcCount; i++) phases[i] = prand() * Math.PI * 2;
  const pcBuf = makeBuf(pcData);
  const phBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, phBuf);
  gl.bufferData(gl.ARRAY_BUFFER, phases, gl.STATIC_DRAW);

  const drawLines = (b, mvp, col, alpha) => {
    gl.useProgram(lineProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
    gl.enableVertexAttribArray(lP);
    gl.vertexAttribPointer(lP, 3, gl.FLOAT, false, 0, 0);
    gl.uniformMatrix4fv(lMvp, false, new Float32Array(mvp));
    gl.uniform3fv(lCol, col);
    gl.uniform1f(lAlpha, alpha);
    gl.drawArrays(gl.LINES, 0, b.count);
  };

  const drawPoints = (mvp, col, alpha, time, energy, size) => {
    gl.useProgram(pointProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, pcBuf.buf);
    gl.enableVertexAttribArray(pP);
    gl.vertexAttribPointer(pP, 3, gl.FLOAT, false, 0, 0);
    if (pPh >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, phBuf);
      gl.enableVertexAttribArray(pPh);
      gl.vertexAttribPointer(pPh, 1, gl.FLOAT, false, 0, 0);
    }
    gl.uniformMatrix4fv(pMvp, false, new Float32Array(mvp));
    gl.uniform3fv(pCol, col);
    gl.uniform1f(pAlpha, alpha);
    gl.uniform1f(pTime, time);
    gl.uniform1f(pEnergy, energy);
    gl.uniform1f(pSize, size);
    gl.drawArrays(gl.POINTS, 0, pcCount);
  };

  const resize = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    return w / h;
  };

  const draw = (t) => {
    const aspect = resize();
    // Smooth energy toward its target — analog transitions, no snapping.
    cerbHoloState.energy += (cerbHoloState.target - cerbHoloState.energy) * 0.06;
    const e = cerbHoloState.energy;
    gl.clear(gl.COLOR_BUFFER_BIT);
    const proj = mPersp(0.9, aspect, 0.1, 20);
    const view = mTrans(0, -0.05, -3.4);

    drawLines(gridBuf, mMul(proj, view), [1.0, 0.16, 0.16], 0.14);

    // Projector light cone — the "emitted" fiction, brighter with energy.
    const cone = mMul(mMul(proj, view), mTrans(0, 0, 0));
    drawLines(coneBuf, cone, [1.0, 0.2, 0.18], 0.05 + e * 0.07);

    // Orbital rings — counter-rotate; speed + brightness scale with energy.
    const r1 = mMul(mMul(proj, view), mMul(mTrans(0, 0.1, 0), mMul(mRotX(1.2), mRotY(t * (0.3 + e * 0.9)))));
    drawLines(ring1, r1, [1.0, 0.2, 0.18], 0.16 + e * 0.16);
    const r2 = mMul(mMul(proj, view), mMul(mTrans(0, 0.1, 0), mMul(mRotX(-0.9), mRotY(-t * (0.22 + e * 0.7)))));
    drawLines(ring2, r2, [1.0, 0.2, 0.18], 0.12 + e * 0.14);

    // The avatar — yaw speed, bob, and high-energy jitter all track energy.
    const yaw = Math.sin(t * (0.55 + e * 1.6)) * (0.42 + e * 0.25);
    const bob = Math.sin(t * (0.9 + e * 1.2)) * 0.045;
    const jitter = e > 0.7 ? Math.sin(t * 40) * 0.004 * e : 0;
    const model = mMul(mTrans(jitter, 0.10 + bob, 0), mMul(mRotX(-0.10), mMul(mRotY(yaw), mScale(1.25))));
    const mvp = mMul(mMul(proj, view), model);

    // Soft halo pass — the skeleton drawn slightly larger and dim, giving
    // the emissive glow a bloom-like fringe (cheap, one extra draw call).
    const halo = mMul(mMul(proj, view), mMul(model, mScale(1.06)));
    drawLines(markBuf, halo, [1.0, 0.18, 0.16], 0.10 + e * 0.10);

    // Wireframe skeleton — emissive pulse, rate scales with energy.
    const pulse = (0.55 + 0.25 * Math.sin(t * (2.1 + e * 3.0))) * (0.5 + e * 0.7);
    drawLines(markBuf, mvp, [1.0, 0.24, 0.20], Math.min(0.9, pulse));

    // Floor reflection — the skeleton mirrored below the grid plane, dim.
    const refl = mMul(mMul(proj, view), mMul(mTrans(jitter, -1.92 - bob, 0), mMul(mScaleY(-1.0), mMul(mRotX(-0.10), mMul(mRotY(yaw), mScale(1.25))))));
    drawLines(markBuf, refl, [1.0, 0.2, 0.18], 0.06);

    // Volumetric particle field over the skeleton.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    drawPoints(mvp, [1.0, 0.30, 0.24], 0.75 + e * 0.3, t, e, 3.0 * dpr);
  };

  // Reduced motion: one static frame (deferred so the canvas is laid out),
  // then no loop.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    requestAnimationFrame(() => draw(1.2));
    if (status) status.textContent = "Static";
    return;
  }

  cerbHoloLive = true;
  if (status) status.textContent = "Projecting";
  let last = performance.now();
  let t = 0;
  const frame = (now) => {
    if (!cerbHoloLive || document.hidden || state.tab !== "chat" || !canvas.isConnected) {
      cerbHoloStop();
      return;
    }
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;
    draw(t);
    cerbHoloRaf = requestAnimationFrame(frame);
  };
  cerbHoloRaf = requestAnimationFrame(frame);
}

// Pause the projection when the tab is hidden; resume when we return to a
// visible Chat pane. Registered once — start/stop are idempotent.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) cerbHoloStop();
  else if (state.tab === "chat") cerbHoloStart();
});

function renderFirstRunWelcome() {
  // First-run dashboard card. Points the user at the 4 high-value next
  // moves so they're not staring at an empty chat input wondering what
  // Cerberus is for. Each card is a real link to the right tab/action,
  // no fake content. Kept compact — this is a welcome, not a tutorial.
  return \`
    <div class="ui-card ui-card-elev" style="margin: var(--space-4) 0; padding: var(--space-5);">
      <h2 style="margin: 0 0 var(--space-2); font-size: 18px;">Welcome to Cerberus 👋</h2>
      <p class="ui-muted" style="margin: 0 0 var(--space-4);">You're set up. Here's what's worth doing first — talk to your agent any time you want, but most users start with one of these:</p>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-3);">
        <a class="ui-card" data-welcome-target="integrations" style="cursor:pointer; text-decoration:none; color:inherit;">
          <div style="font-weight: 600; margin-bottom: 4px;">🔌 Connect your tools</div>
          <div class="ui-meta">Link Linear, Notion, GitHub, Stripe, PostHog and ~20 more so the agent has real data to act on.</div>
        </a>
        <a class="ui-card" data-welcome-target="tasks" style="cursor:pointer; text-decoration:none; color:inherit;">
          <div style="font-weight: 600; margin-bottom: 4px;">📋 Add what's on your plate</div>
          <div class="ui-meta">Drop in tasks you're carrying. The agent will help you triage and remind you when they're due.</div>
        </a>
        <a class="ui-card" data-welcome-target="capture" style="cursor:pointer; text-decoration:none; color:inherit;">
          <div style="font-weight: 600; margin-bottom: 4px;">👀 Enable screen capture (optional)</div>
          <div class="ui-meta">Lets the proactive observer notice routines and propose skills. From the menu bar → Capture → Enable.</div>
        </a>
        <a class="ui-card" data-welcome-target="chat-self" style="cursor:pointer; text-decoration:none; color:inherit;">
          <div style="font-weight: 600; margin-bottom: 4px;">💬 Just say hi</div>
          <div class="ui-meta">Type "what can you do?" below. The agent will tell you what it has access to right now.</div>
        </a>
      </div>
      <button class="ui-btn ui-btn-ghost ui-btn-sm" id="dismissWelcome" style="margin-top: var(--space-3);">Don't show again</button>
    </div>
  \`;
}

function appendMessage(msg, autoscroll = true) {
  const thread = $("thread");
  if (!thread) return;
  // The holo hero is a landing/empty-state element — the moment the first
  // real message lands, tear it down (and its GL loop) so the conversation
  // owns the pane.
  const holo = document.getElementById("holoHero");
  if (holo) { cerbHoloStop(); holo.remove(); }
  const div = document.createElement("div");
  div.className = "msg " + (msg.role === "user" ? "user" : "assistant");
  const meta = msg.role === "assistant" && msg.metadata?.model ? \`\${msg.metadata.model} · \${msg.metadata.provider ?? ""}\` : msg.from ?? "";
  // Assistant replies render markdown; user messages stay literal.
  const body = msg.role === "assistant" ? renderMarkdown(msg.content ?? "") : escapeHtml(msg.content ?? "");
  div.innerHTML = \`<div class="meta">\${escapeHtml(meta)}</div><div class="body">\${body}</div>\`;
  thread.appendChild(div);
  if (autoscroll) thread.scrollTop = thread.scrollHeight;
}

async function refreshCron() {
  const jobs = await fetchJson("/cron");
  sidebarList.innerHTML = jobs.length === 0 ? '<li class="empty">No schedules</li>' : "";
  for (const j of jobs) {
    const li = document.createElement("li");
    li.innerHTML = \`<div class="title">\${escapeHtml(j.name)}</div><div class="preview">\${j.intervalMs ? \`every \${(j.intervalMs/1000).toFixed(0)}s\` : j.dailyAt ? \`daily \${j.dailyAt}\` : "—"} · next \${escapeHtml(new Date(j.nextRunAt).toLocaleString())}</div>\`;
    li.addEventListener("click", () => renderCronDetail(j));
    sidebarList.appendChild(li);
  }
  if (jobs.length > 0) renderCronDetail(jobs[0]);
  else openCronComposer();
}

function renderCronDetail(job) {
  main.innerHTML = \`
    <div class="pane">
      <h2>\${escapeHtml(job.name)}</h2>
      <div class="row" style="gap:6px; margin-bottom: 8px;">
        <span class="badge \${job.enabled ? 'ok' : 'warn'}">\${job.enabled ? "enabled" : "disabled"}</span>
        <span class="badge">task: \${escapeHtml(job.task)}</span>
        <span class="badge">next: \${escapeHtml(new Date(job.nextRunAt).toLocaleString())}</span>
      </div>
      <h3>Input</h3>
      <pre>\${escapeHtml(JSON.stringify(job.input ?? {}, null, 2))}</pre>
      <div class="row" style="gap:8px; margin-top: 16px;">
        <button class="secondary" id="runJob">Run now</button>
        <button class="secondary" id="deleteJob">Delete</button>
      </div>
      <pre id="jobResult" class="ok" style="margin-top: 12px;"></pre>
    </div>
  \`;
  $("runJob").addEventListener("click", async () => {
    const res = await postJson(\`/cron/\${encodeURIComponent(job.id)}/run\`, {});
    $("jobResult").textContent = JSON.stringify(res, null, 2);
  });
  $("deleteJob").addEventListener("click", async () => {
    await fetch(\`/cron/\${encodeURIComponent(job.id)}\`, {
      method: "DELETE",
      headers: projectHeaders()
    });
    refreshCron();
  });
}

async function refreshKanban() {
  const data = await fetchJson("/kanban");
  state.kanban = data;
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const boards = Array.isArray(data.boards) ? data.boards : [];
  const columns = Array.isArray(data.columns)
    ? data.columns
    : ["backlog", "in-progress", "blocked", "on-hold", "review", "done"];
  sidebarList.innerHTML = "";

  if (tasks.length === 0) {
    sidebarList.innerHTML = '<li class="empty">No Kanban tasks</li>';
    openKanbanComposer();
    return;
  }

  for (const board of boards) {
    const boardTasks = tasks.filter((task) => task.board === board.id);
    if (boardTasks.length === 0) continue;
    const boardHeader = document.createElement("li");
    boardHeader.className = "empty";
    boardHeader.style.textTransform = "uppercase";
    boardHeader.style.letterSpacing = ".08em";
    boardHeader.textContent = board.name + " (" + boardTasks.length + ")";
    sidebarList.appendChild(boardHeader);

    for (const column of columns) {
      const columnTasks = boardTasks.filter((task) => task.status === column);
      if (columnTasks.length === 0) continue;
      const columnHeader = document.createElement("li");
      columnHeader.style.padding = "5px 10px 2px";
      columnHeader.style.fontSize = "10px";
      columnHeader.style.color = "var(--muted)";
      columnHeader.textContent = column + " (" + columnTasks.length + ")";
      sidebarList.appendChild(columnHeader);
      for (const task of columnTasks) {
        const li = document.createElement("li");
        li.className = state.kanbanTaskId === task.id ? "active" : "";
        li.innerHTML = \`<div class="title">\${escapeHtml(task.title)}</div><div class="preview">\${escapeHtml(task.assignee || "unassigned")} &middot; \${escapeHtml(task.status)}</div>\`;
        li.addEventListener("click", () => renderKanbanDetail(task.id));
        sidebarList.appendChild(li);
      }
    }
  }

  const selected = tasks.find((task) => task.id === state.kanbanTaskId) ?? tasks[0];
  await renderKanbanDetail(selected.id);
}

async function renderKanbanDetail(taskId) {
  const task = await fetchJson(\`/kanban/\${encodeURIComponent(taskId)}\`);
  state.kanbanTaskId = task.id;
  for (const li of sidebarList.querySelectorAll("li")) li.classList.remove("active");

  const blockers = (task.blockedBy ?? []).length
    ? (task.blockedBy ?? []).map((id) => \`<span class="badge warn">\${escapeHtml(id)}</span>\`).join(" ")
    : '<span class="muted">none</span>';
  const comments = (task.comments ?? []).length
    ? task.comments.map((comment) => \`
        <div class="card" style="margin:6px 0;padding:8px 10px;">
          <div class="muted" style="font-size:11px;">\${escapeHtml(comment.author)} &middot; \${escapeHtml(new Date(comment.createdAt).toLocaleString())}</div>
          <div style="white-space:pre-wrap;">\${escapeHtml(comment.body)}</div>
        </div>
      \`).join("")
    : '<div class="muted">No comments.</div>';
  const runs = (task.runs ?? []).length
    ? task.runs.map((run) => \`
        <tr>
          <td>#\${escapeHtml(run.attempt)}</td>
          <td>\${escapeHtml(run.state)}</td>
          <td>\${escapeHtml(run.worker?.agentName || run.workerId || "")}</td>
          <td>\${escapeHtml(new Date(run.heartbeatAt).toLocaleString())}</td>
        </tr>
      \`).join("")
    : '<tr><td colspan="4" class="muted">No worker attempts yet.</td></tr>';
  const handoffs = (task.handoffs ?? []).length
    ? task.handoffs.map((handoff) => \`
        <li>
          \${escapeHtml(handoff.fromAssignee || "unassigned")} &rarr; \${escapeHtml(handoff.toAssignee)}
          \${handoff.summary ? \`<div class="muted">\${escapeHtml(handoff.summary)}</div>\` : ""}
        </li>
      \`).join("")
    : '<li class="muted">No handoffs yet.</li>';

  main.innerHTML = \`
    <div class="pane">
      <div class="row" style="justify-content:space-between;align-items:flex-start;gap:12px;">
        <div>
          <h2>\${escapeHtml(task.title)}</h2>
          <div class="muted">\${escapeHtml(task.id)} &middot; \${escapeHtml(task.boardName || task.board)}</div>
        </div>
        <span class="badge \${task.status === "blocked" ? "warn" : task.status === "done" ? "ok" : ""}">\${escapeHtml(task.status)}</span>
      </div>
      <div class="row" style="gap:6px;margin:12px 0;">
        <span class="badge">assignee: \${escapeHtml(task.assignee || "unassigned")}</span>
        <span class="badge">runs: \${escapeHtml((task.runs ?? []).length)}</span>
      </div>
      <p style="white-space:pre-wrap;">\${escapeHtml(task.body || "No description.")}</p>
      <h3>Blocked by</h3>
      <div>\${blockers}</div>
      \${task.blockReason ? \`<p class="warn">\${escapeHtml(task.blockReason)}</p>\` : ""}
      <div class="row" style="gap:8px;margin:16px 0;">
        \${task.status === "blocked" ? '<button class="secondary" id="kanbanUnblock">Unblock</button>' : '<button class="secondary" id="kanbanBlock">Block</button>'}
        \${task.status !== "done" ? '<button class="secondary" id="kanbanComplete">Complete</button>' : ""}
      </div>
      <h3>Runs</h3>
      <table>
        <thead><tr><th>Attempt</th><th>State</th><th>Worker</th><th>Heartbeat</th></tr></thead>
        <tbody>\${runs}</tbody>
      </table>
      <h3>Handoffs</h3>
      <ul>\${handoffs}</ul>
      <h3>Comments</h3>
      <div>\${comments}</div>
      <form id="kanbanCommentForm" class="form" style="margin-top:10px;">
        <div class="row" style="gap:8px;">
          <input class="ui-input" name="body" placeholder="Add a comment" required style="flex:1;">
          <button class="secondary" type="submit">Comment</button>
        </div>
      </form>
      <div class="muted" style="margin-top:16px;">Created \${escapeHtml(new Date(task.createdAt).toLocaleString())} &middot; updated \${escapeHtml(new Date(task.updatedAt).toLocaleString())}</div>
    </div>
  \`;

  $("kanbanBlock")?.addEventListener("click", async () => {
    const reason = window.prompt("Why is this task blocked?") || "";
    await postJson("/kanban", { action: "block", taskId: task.id, reason });
    await refreshKanban();
  });
  $("kanbanUnblock")?.addEventListener("click", async () => {
    await postJson("/kanban", { action: "unblock", taskId: task.id });
    await refreshKanban();
  });
  $("kanbanComplete")?.addEventListener("click", async () => {
    const summary = window.prompt("Completion handoff summary") || "";
    await postJson("/kanban", { action: "complete", taskId: task.id, summary });
    await refreshKanban();
  });
  $("kanbanCommentForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    await postJson("/kanban", { action: "comment", taskId: task.id, body: form.get("body") });
    await renderKanbanDetail(task.id);
  });
}

function openKanbanComposer() {
  state.kanbanTaskId = null;
  main.innerHTML = \`
    <div class="pane">
      <h2>New Kanban task</h2>
      <p class="muted">This is the local Cerberus board. Cross-agent shared boards are intentionally separate.</p>
      <form class="form" id="kanbanForm">
        <div style="margin-bottom:var(--space-3);"><label>Title</label><input class="ui-input" name="title" required maxlength="300"></div>
        <div style="margin-bottom:var(--space-3);"><label>Body</label><textarea class="ui-textarea" name="body" rows="5"></textarea></div>
        <div class="row" style="gap:var(--space-2);margin-bottom:var(--space-3);">
          <div style="flex:1;"><label>Board id</label><input class="ui-input" name="board" value="default"></div>
          <div style="flex:1;"><label>Assignee</label><input class="ui-input" name="assignee" placeholder="agent name"></div>
        </div>
        <button class="ui-btn" type="submit">Create task</button>
      </form>
    </div>
  \`;
  $("kanbanForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const created = await postJson("/kanban", {
      title: form.get("title"),
      body: form.get("body"),
      board: form.get("board") || "default",
      assignee: form.get("assignee") || undefined
    });
    state.kanbanTaskId = created.id;
    await refreshKanban();
  });
}

function openCronComposer() {
  main.innerHTML = \`
    <div class="pane">
      <h2 style="margin-bottom: var(--space-2);">New schedule</h2>
      <p class="ui-muted" style="margin-bottom: var(--space-4);">Use this for one-off reminders, recurring agent pulses, or scheduled prompts. The agent's default pulse runs every 30 min — add custom ones here.</p>
      <form class="form" id="cronForm">
        <div style="margin-bottom: var(--space-3);">
          <label>Type</label>
          <select class="ui-select" name="task">
            <option value="prompt">prompt — runs once, replies to channel</option>
            <option value="autopilot">autopilot — proactive pulse, agent decides if it acts</option>
          </select>
        </div>
        <div style="margin-bottom: var(--space-3);"><label>Name</label><input class="ui-input" name="name" placeholder="morning-brief" required></div>
        <div style="margin-bottom: var(--space-3);">
          <label>Prompt (leave blank for autopilot to use the default review prompt)</label>
          <textarea class="ui-textarea" name="prompt" rows="3" placeholder="For autopilot: optional custom pulse prompt. For prompt: what the agent should run."></textarea>
        </div>
        <div class="ui-row" style="gap: var(--space-2); margin-bottom: var(--space-3);">
          <div class="ui-grow"><label>Delay (seconds)</label><input class="ui-input" name="delaySeconds" type="number" min="30" placeholder="60"></div>
          <div class="ui-grow"><label>Interval (seconds)</label><input class="ui-input" name="intervalSeconds" type="number" min="30" placeholder="600"></div>
          <div class="ui-grow"><label>Daily at</label><input class="ui-input" name="dailyAt" placeholder="09:00"></div>
        </div>
        <div class="ui-row" style="gap: var(--space-2); margin-bottom: var(--space-4);">
          <div class="ui-grow"><label>Channel</label>
            <select class="ui-select" name="channel"><option value="local">local</option><option value="telegram">telegram</option></select>
          </div>
          <div class="ui-grow"><label>Target (chatId)</label><input class="ui-input" name="target" placeholder="123456789"></div>
        </div>
        <button class="ui-btn" type="submit">Schedule</button>
      </form>
    </div>
  \`;
  $("cronForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const obj = Object.fromEntries(fd.entries());
    if (obj.delaySeconds) obj.delaySeconds = Number(obj.delaySeconds);
    if (obj.intervalSeconds) obj.intervalSeconds = Number(obj.intervalSeconds);
    const task = obj.task || "prompt";
    obj.task = task;
    obj.input = {
      prompt: obj.prompt || undefined,
      channel: obj.channel,
      target: obj.target || null,
      agentId: "main"
    };
    delete obj.prompt; delete obj.channel; delete obj.target;
    await postJson("/cron", obj);
    await refreshCron();
  });
}

async function refreshSkills(reload = false) {
  if (reload) await postJson("/skills/reload", {});
  const [skills, suggested] = await Promise.all([
    fetchJson("/skills"),
    fetchJson("/skills/suggested").catch(() => [])
  ]);
  const pendingSuggested = suggested.filter((s) => s.status === "pending");

  sidebarList.innerHTML = "";
  if (pendingSuggested.length > 0) {
    const header = document.createElement("li");
    header.style.color = "var(--accent)";
    header.style.fontSize = "11px";
    header.style.padding = "6px 10px 2px";
    header.textContent = \`✨ Suggested · \${pendingSuggested.length}\`;
    sidebarList.appendChild(header);
    for (const s of pendingSuggested) {
      const li = document.createElement("li");
      li.style.borderLeft = "2px solid var(--accent)";
      const sequenceLabels = Array.isArray(s.sequence?.actions)
        ? s.sequence.actions.map((a) => typeof a === "string" ? a : (a.label ?? a.action ?? a.key))
        : (s.sequence?.apps ?? []);
      li.innerHTML = \`<div class="title">\${escapeHtml(s.proposal.name)}</div><div class="preview">\${escapeHtml(s.proposal.description ?? sequenceLabels.join(" → "))}</div>\`;
      li.addEventListener("click", () => renderSuggestedDetail(s));
      sidebarList.appendChild(li);
    }
    const sep = document.createElement("li");
    sep.style.color = "var(--muted)";
    sep.style.fontSize = "11px";
    sep.style.padding = "10px 10px 2px";
    sep.textContent = "Active";
    sidebarList.appendChild(sep);
  }
  if (skills.length === 0 && pendingSuggested.length === 0) {
    sidebarList.innerHTML = '<li class="empty">No skills loaded</li>';
  }
  // Sort: most-used first, then alphabetical — the sidebar doubles as a
  // "what does he actually reach for" ranking.
  const sorted = [...skills].sort((a, b) => ((b.stats?.runs ?? 0) + (b.stats?.views ?? 0)) - ((a.stats?.runs ?? 0) + (a.stats?.views ?? 0)) || a.name.localeCompare(b.name));
  for (const s of sorted) {
    const li = document.createElement("li");
    const st = s.stats ?? {};
    const used = (st.runs ?? 0) + (st.views ?? 0);
    const scoreBadge = typeof st.avgScore === "number"
      ? \`<span class="badge \${st.avgScore >= 0.6 ? "ok" : st.avgScore >= 0.4 ? "" : "err"}" style="font-size:10px;">\${(st.avgScore * 100).toFixed(0)}%</span>\`
      : "";
    li.innerHTML = \`<div class="title">\${s.pinned ? "📌 " : ""}\${escapeHtml(s.name)} \${scoreBadge}</div>
      <div class="preview">\${s.category ? \`<span style="color:var(--accent);">[\${escapeHtml(s.category)}]</span> \` : ""}\${used > 0 ? \`\${used} use\${used > 1 ? "s" : ""} · \` : ""}\${escapeHtml(s.description ?? "")}</div>\`;
    li.addEventListener("click", () => renderSkillDetail(s));
    sidebarList.appendChild(li);
  }

  if (pendingSuggested.length > 0) renderSuggestedDetail(pendingSuggested[0]);
  else if (sorted.length > 0) renderSkillDetail(sorted[0]);
  else main.innerHTML = '<div class="pane"><div class="empty">No skills loaded yet. Drop a SKILL.md into <code>.openagi/skills/&lt;name&gt;/</code>, or let the hourly workflow miner surface a repeated routine.</div></div>';
}

function renderSuggestedDetail(candidate) {
  const seq = candidate.sequence ?? {
    count: candidate.cluster?.count ?? 0,
    actions: candidate.cluster?.keywords ?? [],
    apps: []
  };
  const detectedSteps = Array.isArray(seq.actions) && seq.actions.length > 0
    ? seq.actions.map((a) => ({
        label: typeof a === "string" ? a : (a.label ?? a.action ?? a.key),
        apps: typeof a === "string" ? [] : (a.apps ?? [])
      }))
    : (seq.apps ?? []).map((app) => ({ label: app, apps: [] }));
  const horizons = Array.isArray(seq.horizons) ? seq.horizons : [];
  main.innerHTML = \`
    <div class="pane">
      <div class="row" style="gap:6px;margin-bottom:6px;">
        <span class="badge ok">✨ suggested</span>
        <span class="badge">confidence \${(seq.confidence ?? 0).toFixed(2)}</span>
        <span class="badge">\${seq.count}× in last 28d</span>
        <span class="badge">~\${String(seq.startHour ?? 0).padStart(2, "0")}:00</span>
        \${horizons.map((h) => \`<span class="badge">\${escapeHtml(h)}</span>\`).join("")}
      </div>
      <h2>\${escapeHtml(candidate.proposal.name)}</h2>
      <p class="muted">\${escapeHtml(candidate.proposal.description ?? "")}</p>

      <h3>Detected action workflow</h3>
      <div class="row" style="gap:8px;flex-wrap:wrap;">\${detectedSteps.map((step) => \`<span class="chip" style="font-size:13px;padding:6px 12px;">\${escapeHtml(step.label)}\${step.apps.length ? \` <span class="muted">(\${escapeHtml(step.apps.join(" / "))})</span>\` : ""}</span>\`).join('<span class="muted" style="align-self:center;">→</span>')}</div>

      <h3>Proposed skill body</h3>
      <pre style="white-space:pre-wrap;">\${escapeHtml(candidate.proposal.body ?? "")}</pre>

      \${candidate.proposal.scheduleHint ? \`<h3>Suggested schedule</h3><p>\${escapeHtml(candidate.proposal.scheduleHint)}</p>\` : ""}
      \${candidate.proposal.triggerHint ? \`<h3>Suggested interaction trigger</h3><p>\${escapeHtml(typeof candidate.proposal.triggerHint === "string" ? candidate.proposal.triggerHint : JSON.stringify(candidate.proposal.triggerHint))}</p>\` : ""}

      <div class="row" style="gap:8px;margin-top:14px;">
        <button id="acceptSug">Accept</button>
        <button class="secondary" id="editAcceptSug">Edit & Accept</button>
        <button class="secondary" id="deferSug">Defer</button>
        <button class="secondary" id="rejectSug">Discard</button>
      </div>
      <div id="suggestedEditPanel" style="display:none;margin-top:12px;">
        <label>Skill name</label>
        <input class="ui-input" id="suggestedEditName" value="\${escapeHtml(candidate.proposal.name ?? "")}">
        <label style="margin-top:8px;">Skill body</label>
        <textarea class="ui-textarea" id="suggestedEditBody" rows="12">\${escapeHtml(candidate.proposal.body ?? "")}</textarea>
        <div class="row" style="gap:8px;margin-top:8px;">
          <button id="submitSuggestedEdit">Save edit & accept</button>
          <button class="secondary" id="cancelSuggestedEdit">Cancel</button>
        </div>
      </div>
      <pre id="sugOut" class="ok" style="margin-top:12px;display:none;"></pre>
    </div>
  \`;
  const showOut = (text, cls) => {
    const o = $("sugOut");
    o.style.display = "block";
    o.className = cls === "err" ? "err" : "ok";
    o.textContent = text;
  };
  $("acceptSug").addEventListener("click", async () => {
    try {
      const result = await postJson(\`/proactive/suggestions/\${encodeURIComponent(candidate.id)}/accept\`, {});
      showOut("Accepted: " + JSON.stringify(result, null, 2));
      setTimeout(() => refreshSkills(true), 800);
    } catch (e) { showOut("[err] " + e.message, "err"); }
  });
  $("rejectSug").addEventListener("click", async () => {
    if (!confirm("Discard this suggestion?")) return;
    await postJson(\`/proactive/suggestions/\${encodeURIComponent(candidate.id)}/reject\`, {});
    refreshSkills();
  });
  $("deferSug").addEventListener("click", async () => {
    await postJson(\`/proactive/suggestions/\${encodeURIComponent(candidate.id)}/defer\`, {});
    showToast("Skill candidate deferred", true);
    refreshSkills();
  });
  $("editAcceptSug").addEventListener("click", () => {
    $("suggestedEditPanel").style.display = "block";
    $("suggestedEditBody").focus();
  });
  $("cancelSuggestedEdit").addEventListener("click", () => {
    $("suggestedEditPanel").style.display = "none";
  });
  $("submitSuggestedEdit").addEventListener("click", async () => {
    try {
      const result = await postJson(
        \`/proactive/suggestions/\${encodeURIComponent(candidate.id)}/edit\`,
        {
          name: $("suggestedEditName").value,
          body: $("suggestedEditBody").value
        }
      );
      showOut("Edited and accepted: " + JSON.stringify(result, null, 2));
      setTimeout(() => refreshSkills(true), 800);
    } catch (e) {
      showOut("[err] " + e.message, "err");
    }
  });
}

async function renderSkillDetail(skill) {
  // Pull the full view (body + linked files + stats) and edit history in
  // parallel. count=0 keeps dashboard reads out of the usage stats.
  let full = skill;
  let history = { edits: [] };
  try {
    [full, history] = await Promise.all([
      fetchJson(\`/skills/\${encodeURIComponent(skill.name)}/view?count=0\`),
      fetchJson(\`/skills/history?skill=\${encodeURIComponent(skill.name)}&limit=20\`).catch(() => ({ edits: [] }))
    ]);
  } catch { /* fall back to the list-shape skill */ }
  const st = full.stats ?? skill.stats ?? {};
  const recent = st.recentRuns ?? [];

  // Score sparkline: one bar per recent graded run, colored by band.
  const spark = recent.length
    ? \`<div class="row" style="gap:2px;align-items:flex-end;height:34px;margin:4px 0 2px;">\${recent.map((r) => {
        const h = Math.max(4, Math.round(r.score * 32));
        const c = r.score >= 0.6 ? "var(--ok, #ff7a45)" : r.score >= 0.4 ? "var(--warn, #d9a441)" : "var(--err, #d96b6b)";
        return \`<div title="\${(r.score * 100).toFixed(0)}% · \${escapeHtml(r.at ?? "")}" style="width:10px;height:\${h}px;background:\${c};border-radius:2px 2px 0 0;"></div>\`;
      }).join("")}</div><div class="ui-muted" style="font-size:10px;">last \${recent.length} graded runs →</div>\`
    : '<p class="ui-muted" style="font-size:12px;">No graded runs yet — run it once to start the quality track record.</p>';

  const lineage = [];
  if (full.createdBy) lineage.push(\`created by <strong>\${escapeHtml(full.createdBy)}</strong>\`);
  if (full.createdAt) lineage.push(\`on \${escapeHtml(String(full.createdAt).slice(0, 10))}\`);
  if (full.sourceSuggestionId) lineage.push(\`from suggestion <code>\${escapeHtml(full.sourceSuggestionId)}</code>\`);
  if (full.bundled) lineage.push('<span class="badge">bundled · read-only</span>');

  const linked = (full.linkedFiles ?? []);
  const linkedHtml = linked.length
    ? \`<div class="row" style="gap:6px;flex-wrap:wrap;">\${linked.map((f) => \`<span class="chip linked-file" data-file="\${escapeHtml(f)}" style="cursor:pointer;font-size:12px;" title="Click to view">📄 \${escapeHtml(f)}</span>\`).join("")}</div>\`
    : '<p class="ui-muted" style="font-size:12px;">None — add references/, scripts/, or templates/ inside the skill dir for deep material.</p>';

  const editIcons = { created: "🌱", patched: "🔧", edited: "✏️", pinned: "📌", unpinned: "📍", deleted: "🗑" };
  const historyHtml = (history.edits ?? []).length
    ? \`<div style="border-left:2px solid var(--line);padding-left:12px;">\${history.edits.map((e) => \`
        <div style="margin-bottom:8px;">
          <div style="font-size:12px;">\${editIcons[e.action] ?? "•"} <strong>\${escapeHtml(e.action)}</strong> <span class="ui-muted">by \${escapeHtml(e.by ?? "?")} · \${escapeHtml(String(e.at ?? "").replace("T", " ").slice(0, 16))}</span></div>
          \${e.summary ? \`<div class="ui-muted" style="font-size:11px;white-space:pre-wrap;">\${escapeHtml(e.summary)}</div>\` : ""}
        </div>\`).join("")}</div>\`
    : '<p class="ui-muted" style="font-size:12px;">No recorded edits yet — history starts with the first patch/edit through the new tools.</p>';

  const fmt = (n) => (n === null || n === undefined) ? "—" : (typeof n === "number" && n <= 1 ? (n * 100).toFixed(0) + "%" : String(n));

  main.innerHTML = \`
    <div class="pane">
      <div class="row" style="gap:6px;align-items:center;margin-bottom:2px;">
        <h2 style="margin:0;">\${full.pinned ? "📌 " : ""}\${escapeHtml(full.name)}</h2>
        \${full.category ? \`<span class="badge">\${escapeHtml(full.category)}</span>\` : ""}
      </div>
      <p class="ui-muted" style="margin-bottom: var(--space-2);">\${escapeHtml(full.description ?? "")}</p>
      \${lineage.length ? \`<p class="ui-muted" style="font-size:11px;margin-bottom:var(--space-3);">\${lineage.join(" · ")}</p>\` : ""}

      <div class="row" style="gap:14px;flex-wrap:wrap;margin-bottom:var(--space-3);">
        <div><div style="font-size:20px;font-weight:600;">\${st.runs ?? 0}</div><div class="ui-muted" style="font-size:11px;">runs</div></div>
        <div><div style="font-size:20px;font-weight:600;">\${st.views ?? 0}</div><div class="ui-muted" style="font-size:11px;">loads</div></div>
        <div><div style="font-size:20px;font-weight:600;">\${fmt(st.avgScore)}</div><div class="ui-muted" style="font-size:11px;">avg quality</div></div>
        <div><div style="font-size:20px;font-weight:600;">\${fmt(st.lastScore)}</div><div class="ui-muted" style="font-size:11px;">last score</div></div>
        <div><div style="font-size:14px;font-weight:600;padding-top:4px;">\${st.lastUsedAt ? escapeHtml(String(st.lastUsedAt).replace("T", " ").slice(0, 16)) : "never"}</div><div class="ui-muted" style="font-size:11px;">last used</div></div>
      </div>
      \${spark}

      <div class="ui-section" style="margin-top:var(--space-3);">
        <div class="ui-section-header row" style="justify-content:space-between;align-items:center;">
          <h3>Instructions (SKILL.md)</h3>
          <div class="row" style="gap:6px;">
            \${full.bundled ? "" : \`<button class="ui-btn secondary" id="skillEditBtn" style="font-size:12px;">✏️ Edit</button>
            <button class="ui-btn secondary" id="skillPinBtn" style="font-size:12px;">\${full.pinned ? "📍 Unpin" : "📌 Pin"}</button>
            <button class="ui-btn secondary" id="skillDelBtn" style="font-size:12px;color:var(--err,#d96b6b);">🗑 Delete</button>\`}
          </div>
        </div>
        <pre id="skillBody" style="white-space:pre-wrap;max-height:340px;overflow:auto;">\${escapeHtml(full.body ?? "(body not loaded)")}</pre>
        <div id="skillEditor" style="display:none;">
          <textarea class="ui-textarea" id="skillEditorText" rows="14" style="width:100%;font-family:monospace;font-size:12px;"></textarea>
          <div class="row" style="gap:8px;margin-top:8px;">
            <button class="ui-btn" id="skillSaveBtn">💾 Save body</button>
            <button class="ui-btn secondary" id="skillCancelBtn">Cancel</button>
          </div>
        </div>
      </div>

      <div class="ui-section">
        <div class="ui-section-header"><h3>Linked files</h3></div>
        \${linkedHtml}
        <pre id="linkedOut" style="display:none;white-space:pre-wrap;max-height:260px;overflow:auto;margin-top:8px;"></pre>
      </div>

      <div class="ui-section">
        <div class="ui-section-header"><h3>Edit history</h3></div>
        \${historyHtml}
      </div>

      <div class="ui-section">
        <div class="ui-section-header"><h3>Run</h3></div>
        <form class="form" id="skillForm">
          <div style="margin-bottom: var(--space-3);">
            <label>Input</label>
            <textarea class="ui-textarea" name="input" rows="3" placeholder="Free-text input"></textarea>
          </div>
          <button class="ui-btn" type="submit">Run skill</button>
        </form>
        <pre id="skillOut" class="ok" style="margin-top:8px;"></pre>
      </div>
    </div>
  \`;

  $("skillForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = e.target.input.value;
    const out = $("skillOut");
    out.textContent = "running…";
    try {
      const res = await postJson(\`/skills/\${encodeURIComponent(full.name)}/run\`, { input });
      out.textContent = res.output ?? JSON.stringify(res, null, 2);
      setTimeout(() => renderSkillDetail(full), 1200); // refresh stats + sparkline
    } catch (err) {
      out.textContent = "[error] " + err.message;
    }
  });

  document.querySelectorAll(".linked-file").forEach((chip) => {
    chip.addEventListener("click", async () => {
      const out = $("linkedOut");
      out.style.display = "block";
      out.textContent = "loading…";
      try {
        const res = await fetchJson(\`/skills/\${encodeURIComponent(full.name)}/view?file=\${encodeURIComponent(chip.dataset.file)}\`);
        out.textContent = res.content ?? "(empty)";
      } catch (err) { out.textContent = "[error] " + err.message; }
    });
  });

  $("skillEditBtn")?.addEventListener("click", () => {
    $("skillBody").style.display = "none";
    $("skillEditor").style.display = "block";
    $("skillEditorText").value = full.body ?? "";
  });
  $("skillCancelBtn")?.addEventListener("click", () => {
    $("skillEditor").style.display = "none";
    $("skillBody").style.display = "block";
  });
  $("skillSaveBtn")?.addEventListener("click", async () => {
    try {
      await postJson(\`/skills/\${encodeURIComponent(full.name)}/edit\`, { body: $("skillEditorText").value, by: "dashboard" });
      showToast("Skill body saved", true);
      refreshSkills(true);
    } catch (err) { showToast("Save failed: " + err.message, false); }
  });
  $("skillPinBtn")?.addEventListener("click", async () => {
    try {
      await postJson(\`/skills/\${encodeURIComponent(full.name)}/pin\`, { pinned: !full.pinned, by: "dashboard" });
      refreshSkills(true);
    } catch (err) { showToast("Pin failed: " + err.message, false); }
  });
  $("skillDelBtn")?.addEventListener("click", async () => {
    if (!confirm(\`Delete skill '\${full.name}'? It moves to .trash (recoverable).\`)) return;
    try {
      await postJson(\`/skills/\${encodeURIComponent(full.name)}/delete\`, {});
      showToast("Skill moved to .trash", true);
      refreshSkills(true);
    } catch (err) { showToast("Delete failed: " + err.message, false); }
  });
}

let selectedMcpName = null;
async function refreshMcp() {
  const servers = await fetchJson("/mcp");
  // Preserve scroll position across the full rebuild below — otherwise every
  // SSE "mcp" event (e.g. a connect finishing) snaps the list back to the top.
  const mcpScroller = sidebarList.scrollHeight > sidebarList.clientHeight ? sidebarList : sidebarList.parentElement;
  const mcpSavedScroll = mcpScroller ? mcpScroller.scrollTop : 0;
  sidebarList.innerHTML = "";
  // Always-visible Register button at the top of the MCP sidebar so the
  // user has an unambiguous entry point — separate from the magical
  // tab-aware newBtn at the very top of the sidebar.
  const addItem = document.createElement("li");
  addItem.style.cssText = "border-bottom:1px solid var(--line); padding:8px 10px; cursor:pointer;";
  addItem.innerHTML = '<div class="title" style="color:var(--accent);">+ Register new MCP</div><div class="preview" style="font-size:11px;">stdio · http+bearer · http+oauth</div>';
  addItem.addEventListener("click", () => {
    // Defensive: log + toast on click so even if openMcpComposer
    // throws, the user (and console) sees what happened. Several
    // bug reports about "nothing happens" — instrument so next time
    // it's diagnosable.
    console.log("[Cerberus] MCP +Register clicked");
    try {
      openMcpComposer();
      console.log("[Cerberus] openMcpComposer returned, composerOpen =", composerOpen);
    } catch (err) {
      console.error("[Cerberus] openMcpComposer threw:", err);
      showToast("MCP composer error — check console: " + (err.message || err), false);
    }
  });
  sidebarList.appendChild(addItem);

  if (servers.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No MCP servers registered yet — click + Register above.";
    sidebarList.appendChild(empty);
  }
  for (const s of servers) {
    const li = document.createElement("li");
    if (s.name === selectedMcpName) li.className = "active";
    li.innerHTML = \`<div class="title">\${escapeHtml(s.name)} \${s.connected ? '<span class="badge ok">live</span>' : '<span class="badge">idle</span>'}</div><div class="preview">\${(s.tools ?? []).join(", ") || "—"}</div>\`;
    li.addEventListener("click", () => {
      selectedMcpName = s.name;
      for (const el of sidebarList.querySelectorAll("li")) el.classList.remove("active");
      li.classList.add("active");
      renderMcpDetail(s);
    });
    sidebarList.appendChild(li);
  }
  // Restore the pre-rebuild scroll position now that the list is repopulated.
  if (mcpScroller) mcpScroller.scrollTop = mcpSavedScroll;
  // Show a hero "Register your first MCP" CTA in the main pane when empty.
  if (servers.length === 0) {
    main.innerHTML = \`
      <div class="pane">
        <h2>No MCP servers yet</h2>
        <p>MCP (Model Context Protocol) servers give the agent extra tools — connect Linear, GitHub, your filesystem, etc.</p>
        <p>Click the <strong>+ Register new MCP</strong> button on the left, or use a known catalog suggestion the proactive observer surfaces.</p>
        <button id="emptyRegBtn" style="margin-top:12px;">+ Register new MCP</button>
      </div>
    \`;
    document.getElementById("emptyRegBtn")?.addEventListener("click", () => openMcpComposer());
  } else {
    // Keep the user on the server they're working with — otherwise every SSE
    // refresh (e.g. a connect finishing) snaps the pane back to servers[0],
    // hiding the OAuth banner of the server they actually clicked Connect on.
    const sel = servers.find((s) => s.name === selectedMcpName) || servers[0];
    selectedMcpName = sel.name;
    renderMcpDetail(sel);
  }
}

function renderMcpDetail(server) {
  selectedMcpName = server.name;
  const transportLabel = server.transport === "http" ? \`http · \${escapeHtml(server.auth || "none")}\` : escapeHtml(server.transport);
  const endpoint = server.transport === "http"
    ? \`<pre>\${escapeHtml(server.url || "(no url)")}</pre>\`
    : \`<pre>\${escapeHtml((server.command ?? "—") + " " + (server.args ?? []).join(" "))}</pre>\`;
  const oauthBanner = server.pendingAuthUrl
    ? \`<div class="card warn-banner"><div class="row between" style="align-items:center;">
        <div><span class="name">⚠ OAuth required</span><div class="desc">Click below to authorize this server in your browser. The dashboard will refresh once it's done.</div></div>
        <a class="btn-primary" href="\${escapeHtml(server.pendingAuthUrl)}" target="_blank" rel="noopener">Open in browser</a>
       </div></div>\`
    : "";
  const connectingBanner = server.connecting && !server.connected
    ? \`<div class="card"><div class="row" style="align-items:center; gap:10px; flex-wrap:wrap;"><span class="name">⏳ Connecting…</span><span class="muted" style="flex:1; min-width:0;">waiting for handshake</span></div></div>\`
    : "";
  main.innerHTML = \`
    <div class="pane">
      <h2>\${escapeHtml(server.name)}</h2>
      <div class="row" style="gap: 6px;flex-wrap:wrap;">
        <span class="badge \${server.connected ? 'ok' : ''}">\${server.connected ? "connected" : "disconnected"}</span>
        <span class="badge">trust: \${escapeHtml(server.trustLevel)}</span>
        <span class="badge">transport: \${transportLabel}</span>
        \${server.pendingAuthUrl ? '<span class="badge warn">awaiting auth</span>' : ""}
      </div>
      \${oauthBanner}
      \${connectingBanner}
      <h3>Endpoint</h3>
      \${endpoint}
      <h3>Tools</h3>
      <pre>\${escapeHtml((server.tools ?? []).join("\\n") || "(none — connect to discover)")}</pre>
      <div class="row" style="gap: 8px; margin-top: 12px;flex-wrap:wrap;">
        <button id="connBtn" \${server.connecting ? "disabled" : ""}>\${server.connected ? "Disconnect" : "Connect"}</button>
        \${server.transport === "http" && server.auth === "oauth" ? \`<button class="secondary" id="clearAuthBtn">Re-auth (clear cached token)</button>\` : ""}
        <button class="secondary" id="callBtn">Call tool…</button>
      </div>
      <pre id="mcpOut" class="ok" style="margin-top: 12px;"></pre>
    </div>
  \`;
  $("connBtn").addEventListener("click", async () => {
    const path = server.connected ? "disconnect" : "connect";
    try {
      const res = await postJson(\`/mcp/\${path}/\${encodeURIComponent(server.name)}\`, {});
      $("mcpOut").textContent = res.status === "connecting" ? "Connecting in background — watch this page for the auth URL or tool list." : JSON.stringify(res, null, 2);
      refreshMcp();
    } catch (err) {
      $("mcpOut").textContent = "[error] " + err.message;
    }
  });
  const clearBtn = $("clearAuthBtn");
  if (clearBtn) clearBtn.addEventListener("click", async () => {
    if (!confirm("Clear cached OAuth token for " + server.name + "? Next Connect will run the auth flow again.")) return;
    await postJson(\`/mcp/clear-auth/\${encodeURIComponent(server.name)}\`, {});
    refreshMcp();
  });
  $("callBtn").addEventListener("click", () => {
    const tool = prompt("Tool name?");
    if (!tool) return;
    const args = prompt("JSON args?", "{}");
    postJson("/mcp/call", { server: server.name, tool, args: JSON.parse(args || "{}") })
      .then((r) => $("mcpOut").textContent = JSON.stringify(r, null, 2))
      .catch((e) => $("mcpOut").textContent = "[error] " + e.message);
  });
}

let composerOpen = false;
function openMcpComposer() {
  composerOpen = true;
  main.innerHTML = \`
    <div class="pane">
      <h2 style="margin-bottom: var(--space-2);">Register MCP server</h2>
      <p class="ui-muted" style="margin-bottom: var(--space-4);">For one-click hosted MCPs (Stripe, GitHub, Linear, etc) use the <a href="/?tab=integrations">Integrations</a> catalog. This form is for custom servers — stdio processes or hosted URLs not in the catalog.</p>
      <form class="form" id="mcpForm">
        <div class="ui-section" style="margin-top: 0;">
          <div class="ui-section-header"><h3>Transport</h3></div>
          <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));">
            <label class="opt"><input type="radio" name="kind" value="stdio" checked> <span><strong>stdio</strong><br><span class="ui-meta">spawn a local process</span></span></label>
            <label class="opt"><input type="radio" name="kind" value="http-oauth"> <span><strong>http + OAuth</strong><br><span class="ui-meta">hosted with browser auth</span></span></label>
            <label class="opt"><input type="radio" name="kind" value="http-bearer"> <span><strong>http + bearer</strong><br><span class="ui-meta">hosted with static API key</span></span></label>
          </div>
        </div>

        <div class="ui-section">
          <div class="ui-section-header"><h3>Server</h3></div>
          <div style="margin-bottom: var(--space-3);">
            <label>Name</label>
            <input class="ui-input" name="name" placeholder="e.g. filesystem" required>
          </div>

          <div data-kind="stdio" style="margin-bottom: var(--space-3);">
            <label>Command</label>
            <input class="ui-input" name="command" placeholder="npx">
          </div>
          <div data-kind="stdio">
            <label>Args (one per line)</label>
            <textarea class="ui-textarea" name="args" rows="3" placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;/tmp"></textarea>
          </div>

          <div data-kind="http-oauth http-bearer" style="margin-bottom: var(--space-3);">
            <label>URL</label>
            <input class="ui-input" name="url" placeholder="https://mcp.example.com/mcp">
          </div>
          <div data-kind="http-bearer">
            <label>API key secret reference (exact \\\${ENV_VAR})</label>
            <input class="ui-input" name="apiKey" placeholder="\\\${MY_MCP_KEY}">
          </div>
          <div data-kind="http-oauth" style="margin-bottom: var(--space-3);">
            <label>Pre-registered Client ID <span class="ui-meta">· optional, only if your auth server doesn't support dynamic registration</span></label>
            <input class="ui-input" name="clientId" placeholder="\\\${OAUTH_CLIENT_ID} or literal">
          </div>
          <div data-kind="http-oauth">
            <label>Client secret reference <span class="ui-meta">· optional exact \\\${ENV_VAR}; store the value through Secrets first</span></label>
            <input class="ui-input" name="clientSecret" placeholder="\\\${MY_OAUTH_CLIENT_SECRET}" autocomplete="off">
          </div>
        </div>

        <div class="ui-section">
          <div class="ui-section-header"><h3>Trust level</h3></div>
          <select class="ui-select" name="trustLevel">
            <option>trusted</option>
            <option>untrusted</option>
          </select>
          <div class="ui-meta" style="margin-top: var(--space-1);">Trusted servers can be called automatically; untrusted require explicit approval per call.</div>
        </div>

        <div class="ui-row" style="margin-top: var(--space-4);">
          <button class="ui-btn" type="submit" id="registerSubmit">Register</button>
          <button class="ui-btn ui-btn-ghost" type="button" id="cancelBtn">Cancel</button>
        </div>
        <pre id="mcpRegOut" class="ok" style="display:none;margin-top: var(--space-3);"></pre>
      </form>
    </div>
  \`;
  const showOut = (text, cls) => {
    const el = $("mcpRegOut");
    el.style.display = "block";
    el.className = cls === "err" ? "err" : "ok";
    el.textContent = text;
  };
  const updateKindVisibility = () => {
    const checked = document.querySelector('#mcpForm input[name="kind"]:checked');
    const kind = checked ? checked.value : "stdio";
    document.querySelectorAll("[data-kind]").forEach((el) => {
      el.style.display = el.dataset.kind.split(" ").includes(kind) ? "" : "none";
    });
  };
  document.querySelectorAll('#mcpForm input[name="kind"]').forEach((r) =>
    r.addEventListener("change", updateKindVisibility));
  updateKindVisibility();
  $("cancelBtn").addEventListener("click", () => { composerOpen = false; refreshMcp(); });

  // Defense in depth: bind both the form submit AND a direct click on the
  // Register button. Some environments (older Safari, browser extensions
  // intercepting forms) suppress the submit event; the click fallback uses
  // requestSubmit() which still triggers our handler if it's wired, and
  // falls back to invoking the same logic directly otherwise.
  const submitForm = async (e) => {
    if (e) e.preventDefault();
    const formEl = $("mcpForm");
    if (!formEl) return;
    if (formEl.dataset.submitting === "1") return;
    formEl.dataset.submitting = "1";
    const fd = new FormData(formEl);
    const kind = fd.get("kind") || "stdio";
    const body = {
      name: (fd.get("name") || "").trim(),
      trustLevel: fd.get("trustLevel") || "trusted"
    };
    if (kind === "stdio") {
      body.command = (fd.get("command") || "").trim();
      body.args = (fd.get("args") || "").split("\\n").map((s) => s.trim()).filter(Boolean);
    } else if (kind === "http-oauth") {
      body.url = (fd.get("url") || "").trim();
      body.auth = "oauth";
      const clientId = (fd.get("clientId") || "").trim();
      const clientSecret = (fd.get("clientSecret") || "").trim();
      if (clientId) body.clientId = clientId;
      if (clientSecret) body.clientSecret = clientSecret;
    } else if (kind === "http-bearer") {
      body.url = (fd.get("url") || "").trim();
      body.auth = "bearer";
      body.apiKey = (fd.get("apiKey") || "").trim();
    }
    const reset = () => { formEl.dataset.submitting = ""; };
    if (!body.name) { showOut("name is required", "err"); reset(); return; }
    if (kind === "stdio" && !body.command) { showOut("command is required for stdio", "err"); reset(); return; }
    if ((kind === "http-oauth" || kind === "http-bearer") && !body.url) { showOut("url is required for http", "err"); reset(); return; }
    if (kind === "http-bearer" && !body.apiKey) { showOut("apiKey is required for http+bearer", "err"); reset(); return; }
    const isSecretReference = (value) => (
      typeof value === "string"
      && value.startsWith("$" + "{")
      && value.endsWith("}")
      && /^[A-Z_][A-Z0-9_]*$/.test(value.slice(2, -1))
    );
    if (body.apiKey && !isSecretReference(body.apiKey)) {
      showOut("apiKey must be an exact \${ENV_VAR} secret reference", "err");
      reset();
      return;
    }
    if (body.clientSecret && !isSecretReference(body.clientSecret)) {
      showOut("clientSecret must be an exact \${ENV_VAR} secret reference", "err");
      reset();
      return;
    }

    const btn = $("registerSubmit");
    btn.disabled = true;
    btn.textContent = "Registering…";
    try {
      const result = await postJson("/mcp/register", body);
      showOut("Registered ✓ — " + JSON.stringify(result, null, 2));
      composerOpen = false;
      setTimeout(() => refreshMcp(), 600);
    } catch (err) {
      showOut("Registration failed: " + (err.message || String(err)), "err");
      btn.disabled = false;
      btn.textContent = "Register";
      reset();
    }
  };
  $("mcpForm").addEventListener("submit", submitForm);
  $("registerSubmit").addEventListener("click", (e) => {
    // If the button is type=submit inside a form, the browser will fire
    // submit on its own — but if anything intercepts that path, this
    // explicit click handler still drives the registration.
    if (e.defaultPrevented) return;
    const f = $("mcpForm");
    if (!f) return;
    if (typeof f.requestSubmit === "function") {
      e.preventDefault();
      f.requestSubmit();
    } else {
      submitForm(e);
    }
  });
}

async function renderModels() {
  const [data, gateway] = await Promise.all([
    fetchJson("/providers", { projectScoped: false }),
    fetchJson("/gateway/status", { projectScoped: false }).catch((e) => ({ error: e.message }))
  ]);
  const presets = Array.isArray(data.presets) ? data.presets : [];

  const cards = presets.map((p) => {
    const modelOptions = (p.models || [])
      .map((m) => '<option value="' + escapeHtml(m) + '"' + (m === p.defaultModel ? " selected" : "") + ">" + escapeHtml(m) + "</option>")
      .join("");
    const keyState = p.keyPreview
      ? '<span class="badge ok">key ' + escapeHtml(p.keyPreview) + "</span>"
      : '<span class="badge warn">no key</span>';
    const activeBadge = p.active ? '<span class="badge ok">LIVE</span>' : "";
    const oauthNote = p.oauth
      ? '<a href="' + escapeHtml(p.keyUrl) + '" target="_blank" rel="noopener">Sign in / get key ↗</a>'
      : '<a href="' + escapeHtml(p.keyUrl) + '" target="_blank" rel="noopener">Get API key ↗</a> <span class="sub">(API key only — no OAuth)</span>';
    return '<div class="card" data-provider="' + escapeHtml(p.id) + '">'
      + '<div class="row between"><span class="name">' + escapeHtml(p.label) + "</span>"
      + '<span class="row" style="gap:6px;">' + activeBadge + keyState + "</span></div>"
      + '<div class="desc">' + escapeHtml(p.note) + "</div>"
      + '<div class="desc sub">' + escapeHtml(p.baseUrl) + " · key env <code>" + escapeHtml(p.keyEnv) + "</code></div>"
      + '<div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap;">'
      + '<input type="password" class="prov-key" placeholder="Paste ' + escapeHtml(p.keyEnv) + '" autocomplete="off" style="flex:1;min-width:180px;">'
      + '<button class="prov-save">Save key</button></div>'
      + '<div class="row" style="gap:6px;margin-top:6px;flex-wrap:wrap;">'
      + '<select class="prov-model" style="flex:1;min-width:180px;">' + modelOptions + "</select>"
      + '<button class="prov-activate"' + (p.configured ? "" : " disabled") + ">Make active</button></div>"
      + '<div class="desc" style="margin-top:6px;">' + oauthNote + "</div>"
      + "</div>";
  }).join("");

  const upd = gateway.update ?? {};
  const updateLine = gateway.error
    ? "Gateway status unavailable: " + escapeHtml(gateway.error)
    : upd.error
      ? "Update check failed: " + escapeHtml(String(upd.error))
      : upd.updateAvailable
        ? "Update available — " + escapeHtml(String(upd.behind ?? "?")) + " commit(s) behind."
        : "Up to date.";
  const supervisedNote = gateway.supervised
    ? "Supervised — restart is safe; the service manager brings the gateway back."
    : "No supervisor detected. Restart is disabled: exiting would stop the agent, not restart it.";

  main.innerHTML = '<div class="pane">'
    + "<h2>Models &amp; Providers</h2>"
    + '<div class="desc">Live lane: <strong>' + escapeHtml(String(data.lane || "auto")) + "</strong>"
    + " · active preset: <strong>" + escapeHtml(String(data.active || "none")) + "</strong>"
    + " · model: <code>" + escapeHtml(String(data.liveModel || "?")) + "</code></div>"
    + '<div class="desc sub">Keys are stored in the secrets vault and never sent back to this page — only a masked preview. Saving a key does not switch providers; press <em>Make active</em> to point the live lane at it.</div>'
    + '<div class="grid" id="providerGrid" style="margin-top:12px;">' + cards + "</div>"
    + "<h3>Gateway</h3>"
    + '<div class="card"><div class="row between"><span class="name">openAGI daemon</span>'
    + '<span class="badge">pid ' + escapeHtml(String(gateway.pid ?? "?")) + "</span></div>"
    + '<div class="desc">uptime ' + escapeHtml(String(gateway.uptimeSeconds ?? "?")) + "s · node " + escapeHtml(String(gateway.nodeVersion ?? "?")) + "</div>"
    + '<div class="desc">' + updateLine + "</div>"
    + '<div class="desc sub">' + escapeHtml(supervisedNote) + "</div>"
    + '<div class="row" style="gap:6px;margin-top:8px;">'
    + '<button id="gwUpdate">Pull update</button>'
    + '<button id="gwRestart"' + (gateway.supervised ? "" : " disabled") + ">Restart gateway</button></div>"
    + '<div class="desc" id="gwResult"></div></div>'
    + "</div>";

  const grid = document.getElementById("providerGrid");
  grid.querySelectorAll(".card").forEach((card) => {
    const id = card.getAttribute("data-provider");
    card.querySelector(".prov-save").addEventListener("click", async () => {
      const input = card.querySelector(".prov-key");
      const apiKey = input.value.trim();
      if (!apiKey) return;
      try {
        await postJson("/providers/key", { id, apiKey });
        // Clear immediately: the key must not linger in the DOM.
        input.value = "";
        await renderModels();
      } catch (e) {
        alert("Could not save key: " + e.message);
      }
    });
    card.querySelector(".prov-activate").addEventListener("click", async () => {
      const model = card.querySelector(".prov-model").value;
      try {
        const result = await postJson("/providers/activate", { id, model });
        await renderModels();
        alert("Now running " + result.active + " on " + (result.model || "?"));
      } catch (e) {
        alert("Could not activate: " + e.message);
      }
    });
  });

  const gwResult = document.getElementById("gwResult");
  document.getElementById("gwUpdate").addEventListener("click", async () => {
    gwResult.textContent = "Pulling…";
    try {
      const r = await postJson("/gateway/update", {});
      gwResult.textContent = r.updated
        ? "Updated. Restart the gateway to run the new code."
        : "Already up to date.";
    } catch (e) {
      gwResult.textContent = "Update failed: " + e.message;
    }
  });
  document.getElementById("gwRestart").addEventListener("click", async () => {
    if (!confirm("Restart the gateway? In-flight turns will be dropped.")) return;
    gwResult.textContent = "Restarting…";
    try {
      await postJson("/gateway/restart", {});
      // The process exits; poll until the new one answers.
      const waitForBoot = async (attempt) => {
        if (attempt > 40) { gwResult.textContent = "Gateway did not come back — check the service."; return; }
        try {
          const s = await fetchJson("/gateway/status", { projectScoped: false });
          gwResult.textContent = "Back up — pid " + s.pid + ".";
          await renderModels();
        } catch {
          setTimeout(() => waitForBoot(attempt + 1), 500);
        }
      };
      setTimeout(() => waitForBoot(0), 1200);
    } catch (e) {
      gwResult.textContent = "Restart refused: " + e.message;
    }
  });
}

async function renderAgents() {
  const agents = await fetchJson("/agents");
  main.innerHTML = '<div class="pane"><h2>Agents</h2><div class="grid" id="agentList"></div></div>';
  const list = $("agentList");
  for (const a of agents) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = \`<div class="row between"><span class="name">\${escapeHtml(a.name)}</span><span class="badge">\${escapeHtml(a.role)}</span></div><div class="desc">\${escapeHtml(a.scope || a.systemPrompt || "—")}</div>\`;
    list.appendChild(card);
  }
}

async function renderMemory() {
  const snap = await fetchJson("/memory");
  state.memorySnap = snap;
  if (!state.memoryFilter) state.memoryFilter = { tier: "all", query: "" };
  renderMemoryView();
}

function renderMemoryView() {
  const snap = state.memorySnap || { short: [], medium: [], long: [] };
  const f = state.memoryFilter;
  const counts = { short: snap.short.length, medium: snap.medium.length, long: snap.long.length };
  const total = counts.short + counts.medium + counts.long;
  const principles = snap.long.filter((m) => m.kind === "principle").length;

  main.innerHTML = \`
    <div class="pane">
      <div class="row between" style="margin-bottom:14px;align-items:center;flex-wrap:wrap;gap:10px;">
        <h2 style="margin:0;">Memory <span class="muted" style="font-weight:400;font-size:14px;">· \${total} total · \${principles} principle\${principles===1?"":"s"}\${uiHelp("Principles are durable rules promoted from repeated raw memories. They live in long-tier and resist decay.")}</span></h2>
      </div>
      <div id="memoryPageChat"></div>
      <div class="row" style="gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap;">
        <div class="tier-pills">
          <button data-tier="all" class="\${f.tier==='all'?'active':''}">All <span class="count">\${total}</span></button>
          <button data-tier="short" class="\${f.tier==='short'?'active':''}" title="RAM — what you need right now. Decays fastest.">Short <span class="count">\${counts.short}</span></button>
          <button data-tier="medium" class="\${f.tier==='medium'?'active':''}" title="Day-to-day. Promoted from short-tier when repeated; demoted to long if it sticks.">Medium <span class="count">\${counts.medium}</span></button>
          <button data-tier="long" class="\${f.tier==='long'?'active':''}" title="Lava — durable truths. Raw items + condensed principles that survived multiple reinforcements.">Long <span class="count">\${counts.long}</span></button>
        </div>
        <input type="search" id="memSearch" placeholder="search content or tags…" value="\${escapeHtml(f.query)}" style="flex:1;min-width:240px;">
      </div>
      <div class="mem-grid" id="memList"></div>
    </div>
  \`;
  renderPageChatComposer(document.getElementById("memoryPageChat"), {
    placeholder: 'e.g. "Remember that my standup is 9am Mondays" or "what do I remember about Sarah?"',
    onAfterSend: async () => {
      // Reply may have caused a remember/recall — refresh the snapshot.
      const snap = await fetchJson("/memory");
      state.memorySnap = snap;
      renderMemoryView();
    }
  });
  document.querySelectorAll("[data-tier]").forEach((b) =>
    b.addEventListener("click", () => { state.memoryFilter.tier = b.dataset.tier; renderMemoryView(); })
  );
  const search = $("memSearch");
  if (search) {
    search.addEventListener("input", (e) => {
      state.memoryFilter.query = e.target.value;
      fillMemoryGrid();
    });
  }
  fillMemoryGrid();
}

function fillMemoryGrid() {
  const snap = state.memorySnap || {};
  const f = state.memoryFilter;
  const list = $("memList");
  if (!list) return;

  let items = [];
  if (f.tier === "all" || f.tier === "short") items = items.concat((snap.short ?? []).map((m) => ({ ...m, _tier: "short" })));
  if (f.tier === "all" || f.tier === "medium") items = items.concat((snap.medium ?? []).map((m) => ({ ...m, _tier: "medium" })));
  if (f.tier === "all" || f.tier === "long") items = items.concat((snap.long ?? []).map((m) => ({ ...m, _tier: "long" })));

  if (f.query) {
    const q = f.query.toLowerCase();
    items = items.filter((m) =>
      (m.content || "").toLowerCase().includes(q) ||
      (m.tags || []).some((t) => String(t).toLowerCase().includes(q))
    );
  }

  items.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  if (items.length === 0) {
    list.innerHTML = '<div class="empty">No memory items match this filter.</div>';
    return;
  }

  list.innerHTML = items.map((m) => {
    const tags = (m.tags || []).slice(0, 6).map((t) => \`<span class="chip">\${escapeHtml(t)}</span>\`).join("");
    const kindBadge = m.kind === "principle" ? '<span class="badge ok">principle</span>' : "";
    const dangerBadge = (m.dangerLevel || 0) > 0.7 ? '<span class="badge err">⚠ danger</span>' : "";
    const scopeBadge = m.scope && m.scope !== "main" ? \`<span class="badge">\${escapeHtml(m.scope)}</span>\` : "";
    const age = m.createdAt ? timeAgo(m.createdAt) : "";
    return \`
      <div class="mem-card tier-\${m._tier}">
        <div class="mem-head">
          <span class="badge tier-\${m._tier}">\${m._tier}</span>
          \${kindBadge}\${dangerBadge}\${scopeBadge}
          <span class="badge">str \${(m.strength ?? 0).toFixed(2)}</span>
          <span class="mem-age">\${escapeHtml(age)}</span>
        </div>
        <div class="mem-content">\${escapeHtml(m.content || "")}</div>
        \${tags ? \`<div class="mem-tags">\${tags}</div>\` : ""}
      </div>
    \`;
  }).join("");
}

function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return "just now";
  if (ms < 3600000) return Math.floor(ms / 60000) + "m ago";
  if (ms < 86400000) return Math.floor(ms / 3600000) + "h ago";
  return Math.floor(ms / 86400000) + "d ago";
}

async function renderNodes() {
  const data = await fetchJson("/nodes");
  const roleLabel = data.self.role === "main" ? "Main" : "Node";
  const pairedLine = data.self.role === "node"
    ? \`<div class="desc">Paired to: <code>\${escapeHtml(data.self.pairedTo)}</code></div>\`
    : \`<div class="desc">This machine is a main — other nodes heartbeat to it.</div>\`;
  const staleBanner = data.stale
    ? \`<div class="card" style="border-color:var(--warn,#c8963e);"><div class="name warn">Showing cached topology\${data.cachedAt ? \` as of \${escapeHtml(new Date(data.cachedAt).toLocaleTimeString())}\` : ""}</div><div class="desc">Could not reach the main just now — this is the last known roster.</div></div>\`
    : "";
  const rows = data.nodes.length > 0
    ? data.nodes.map((n) => \`
        <tr>
          <td>\${escapeHtml(n.name)}</td>
          <td>\${escapeHtml(n.role)}</td>
          <td><span class="\${n.status === "online" ? "name" : "name warn"}">\${n.status}</span></td>
          <td>\${escapeHtml(new Date(n.lastSeenAt).toLocaleString())}</td>
          <td>\${escapeHtml(n.version ?? "")}</td>
        </tr>\`).join("")
    : \`<tr><td colspan="5" class="desc">No other nodes have checked in yet.</td></tr>\`;
  main.innerHTML = \`
    <div class="pane">
      <h2>Nodes</h2>
      <div class="card">
        <div class="name">\${escapeHtml(data.self.name)} (this machine) — \${roleLabel}</div>
        \${pairedLine}
        <div class="desc">Version: \${escapeHtml(data.self.version ?? "unknown")}</div>
      </div>
      \${staleBanner}
      <table class="grid" style="margin-top:12px; width:100%;">
        <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Last seen</th><th>Version</th></tr></thead>
        <tbody>\${rows}</tbody>
      </table>
    </div>
  \`;
}

async function renderChannels() {
  const ch = await fetchJson("/channels");
  const bbWebhookLine = ch.buildBetterWebhookReady
    ? \`<div class="desc" style="margin-top:6px;">BuildBetter webhook endpoint: <code>\${escapeHtml(ch.buildBetterWebhook)}</code> <span class="sub">— authentication is configured. Send the saved secret as <code>X-BuildBetter-Webhook-Secret</code>, or append it as <code>?secret=...</code> in BuildBetter; the dashboard keeps it hidden.</span></div>\`
    : (ch.publicUrl ? \`<div class="desc" style="margin-top:6px;" class="sub">BuildBetter webhook: set <code>BUILDBETTER_WEBHOOK_SECRET</code> to enable instant call sync.</div>\` : "");
  const tunnelBlock = ch.publicUrl
    ? \`<div class="card"><div class="name">Public URL</div><div class="desc"><code>\${escapeHtml(ch.publicUrl)}</code></div>\${bbWebhookLine}</div>\`
    : \`<div class="card"><div class="name warn">No public URL</div><div class="desc">Run <code>npm run tunnel</code>, then set <code>OPENAGI_PUBLIC_URL</code> in .openagi/.env and restart.</div></div>\`;
  main.innerHTML = \`
    <div class="pane">
      <h2>Channels</h2>
      \${tunnelBlock}
      <div class="grid two" style="margin-top:12px;">
        <div class="card"><div class="name">Local · \${ch.local?.mode ?? ""}</div><div class="desc">Browser HTTP + SSE.</div></div>
        <div class="card"><div class="name">Telegram</div><div class="desc">\${ch.telegram?.configured ? "configured" : "no token"} · polling: \${ch.telegram?.polling ? "on" : "off"}</div></div>
      </div>
    </div>
  \`;
}

async function renderBudget() {
  const b = await fetchJson("/budget");
  const capped = b.enabled !== false && b.dailyUsdLimit !== null;
  const pct = capped
    ? Math.min(100, (b.spentUsd / Math.max(b.dailyUsdLimit, 0.0001)) * 100)
    : 0;
  const stateClass = capped && pct > 90
    ? "err"
    : capped && pct > 70
      ? "warn"
      : "ok";
  const unpriced = Array.isArray(b.unpricedModels) ? b.unpricedModels : [];
  const unpricedWarning = unpriced.length
    ? \`<div class="card" style="margin-top:12px;">
        <div class="row between">
          <span class="name">Estimated model pricing</span>
          <span class="badge warn">\${unpriced.length} unpriced</span>
        </div>
        <div class="desc" style="margin-top:6px;">
          Default rates are being used for: \${escapeHtml(unpriced.join(", "))}
        </div>
      </div>\`
    : "";
  main.innerHTML = \`
    <div class="pane">
      <h2>Credits</h2>
      <div class="card">
        <div class="row between" style="align-items:center;">
          <span class="name">Today · \${escapeHtml(b.today)}</span>
          <span class="badge \${stateClass}">\${capped ? pct.toFixed(0) + "% of limit" : "Guard disabled"}</span>
        </div>
        <div style="margin-top:10px;height:8px;background:var(--panel-2);border-radius:4px;overflow:hidden;">
          <div style="width:\${pct}%;height:100%;background:var(--accent);transition:width .3s;"></div>
        </div>
      </div>
      \${unpricedWarning}

      <h3>Today</h3>
      <div class="grid stats">
        <div class="card"><span class="desc">Spent</span><div class="stat-value">$\${b.spentUsd.toFixed(4)}</div></div>
        <div class="card"><span class="desc">Remaining</span><div class="stat-value">\${capped ? "$" + b.remainingUsd.toFixed(4) : "No cap"}</div></div>
        <div class="card"><span class="desc">Daily limit</span><div class="stat-value">\${capped ? "$" + b.dailyUsdLimit.toFixed(2) : "Disabled"}</div></div>
        <div class="card"><span class="desc">Calls</span><div class="stat-value">\${b.calls}</div></div>
        <div class="card"><span class="desc">Input tokens</span><div class="stat-value">\${b.tokens.input.toLocaleString()}</div></div>
        <div class="card"><span class="desc">Output tokens</span><div class="stat-value">\${b.tokens.output.toLocaleString()}</div></div>
        <div class="card"><span class="desc">Cache read</span><div class="stat-value">\${b.tokens.cacheRead.toLocaleString()}</div></div>
        <div class="card"><span class="desc">Cache write</span><div class="stat-value">\${b.tokens.cacheWrite.toLocaleString()}</div></div>
      </div>

      <h3>Daily guard</h3>
      <form id="budgetLimitForm" class="card">
        <div class="row" style="align-items:center;gap:16px;flex-wrap:wrap;">
          <label class="row" style="align-items:center;gap:6px;">
            <input type="radio" name="budgetLimitMode" value="limit" \${capped ? "checked" : ""}>
            Enabled
          </label>
          <input id="budgetLimitInput" class="ui-input" type="number" min="0.01" step="0.01"
            value="\${escapeHtml(String(capped ? b.dailyUsdLimit : 10))}" \${capped ? "" : "disabled"}
            aria-label="Daily budget limit in USD" style="max-width:180px;">
          <label class="row" style="align-items:center;gap:6px;">
            <input type="radio" name="budgetLimitMode" value="off" \${capped ? "" : "checked"}>
            Disabled
          </label>
          <button class="secondary" type="submit">Save limit</button>
        </div>
        <div id="budgetLimitMessage" class="desc" style="margin-top:8px;">
          Spend remains tracked when the guard is disabled.
        </div>
      </form>

      <h3>Last 14 days</h3>
      <div id="budgetHistory" class="grid"></div>
      <h3>Spend over time (30 days)</h3>
      <div id="creditChart" class="card"></div>
      <h3>By activity (30 days)</h3>
      <div id="creditByActivity" class="grid"></div>
      <h3>By model (30 days)</h3>
      <div id="creditByModel" class="grid"></div>
      <h3>Audit log</h3>
      <div id="creditLog"></div>
    </div>
  \`;
  const limitInput = $("budgetLimitInput");
  for (const radio of document.querySelectorAll('input[name="budgetLimitMode"]')) {
    radio.addEventListener("change", () => {
      limitInput.disabled = radio.value === "off" && radio.checked;
    });
  }
  $("budgetLimitForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = $("budgetLimitMessage");
    const mode = document.querySelector('input[name="budgetLimitMode"]:checked')?.value;
    const limit = mode === "off" ? "off" : Number(limitInput.value);
    try {
      message.textContent = "Saving...";
      await postJson("/budget/limit", { limit });
      await renderBudget();
    } catch (error) {
      message.textContent = error.message;
    }
  });
  const hist = $("budgetHistory");
  for (const d of (b.history ?? [])) {
    const c = document.createElement("div");
    c.className = "card";
    c.innerHTML = \`<div class="row between"><span class="name">\${escapeHtml(d.date)}</span><span class="muted">\${d.calls} call\${d.calls===1?"":"s"}</span></div><div class="stat-value">$\${d.usd.toFixed(4)}</div>\`;
    hist.appendChild(c);
  }
  const led = await fetchJson("/budget/ledger?days=30").catch(() => null);
  if (led && !led.error) {
    const days = led.analytics.byDay;
    const maxUsd = Math.max(0.0001, ...days.map((d) => d.usd));
    const bw = 100 / Math.max(days.length, 1);
    const bars = days.map((d, i) => {
      const h = Math.max(1, (d.usd / maxUsd) * 90);
      return \`<rect x="\${(i * bw).toFixed(2)}" y="\${(100 - h).toFixed(2)}" width="\${(bw * 0.8).toFixed(2)}" height="\${h.toFixed(2)}"><title>\${escapeHtml(d.date)}: $\${d.usd.toFixed(4)} (\${d.calls})</title></rect>\`;
    }).join("");
    $("creditChart").innerHTML = \`<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:120px;fill:var(--accent);">\${bars}</svg>\`;

    const fill = (id, items, key) => {
      const el = $(id); el.innerHTML = "";
      for (const it of items) {
        const c = document.createElement("div"); c.className = "card";
        c.innerHTML = \`<div class="row between"><span class="name">\${escapeHtml(String(it[key]))}</span><span class="muted">\${it.calls} call\${it.calls === 1 ? "" : "s"}</span></div><div class="stat-value">$\${it.usd.toFixed(4)}</div>\`;
        el.appendChild(c);
      }
    };
    fill("creditByActivity", led.analytics.byActivity, "activity");
    fill("creditByModel", led.analytics.byModel, "model");

    const log = $("creditLog");
    log.innerHTML = "";
    for (const e of led.entries.slice(0, 200)) {
      const t = (e.at || "").slice(0, 16).replace("T", " ");
      const tools = (e.tools || []).join(", ");
      const row = document.createElement("div"); row.className = "card";
      row.innerHTML = \`<div class="row between"><span class="name">\${escapeHtml(e.model || "?")}</span><span class="stat-value">$\${Number(e.usd || 0).toFixed(4)}</span></div><div class="muted" style="font-size:11px;">\${escapeHtml(t)} · \${escapeHtml(e.channel || "?")}\${e.agentId ? " · " + escapeHtml(e.agentId) : ""}\${tools ? " · " + escapeHtml(tools) : ""}</div>\`;
      log.appendChild(row);
    }
    if (led.entries.length > 200) {
      const more = document.createElement("p"); more.className = "desc";
      more.textContent = "Showing the most recent 200 of " + led.entries.length + " calls.";
      log.appendChild(more);
    }
  }
}

async function renderOutcomes() {
  const data = await fetchJson("/outcomes?limit=40&windowDays=7");
  const agg = data.aggregate ?? {};
  const recent = data.recent ?? [];
  const byKindCards = Object.entries(agg.byKind ?? {})
    .map(([k, v]) => \`<div class="card"><span class="desc">\${escapeHtml(k)}</span><div class="stat-value">\${v}</div></div>\`)
    .join("");
  main.innerHTML = \`
    <div class="pane">
      <h2>Outcomes <span class="muted" style="font-size:14px;font-weight:400;">· last 7 days</span></h2>
      <div class="grid stats">
        <div class="card"><span class="desc">Avg quality</span><div class="stat-value">\${agg.avgQuality ?? "—"}</div></div>
        <div class="card"><span class="desc">Resolved</span><div class="stat-value">\${agg.resolved ?? 0} <span class="muted" style="font-size:14px;">/ \${agg.total ?? 0}</span></div></div>
        <div class="card"><span class="desc">Pending</span><div class="stat-value">\${agg.pending ?? 0}</div></div>
      </div>
      \${byKindCards ? \`<h3>By kind</h3><div class="grid stats">\${byKindCards}</div>\` : ""}
      <h3>Recent</h3>
      <div class="grid" id="outcomeList"></div>
    </div>
  \`;
  const list = $("outcomeList");
  for (const o of recent) {
    const el = document.createElement("div");
    el.className = "card";
    const qBadge = typeof o.qualityScore === "number"
      ? \`<span class="badge \${o.qualityScore >= 0.7 ? "ok" : o.qualityScore >= 0.4 ? "warn" : "err"}">q=\${o.qualityScore.toFixed(2)}</span>\`
      : (o.resolved ? '<span class="badge">timeout</span>' : '<span class="badge warn">pending</span>');
    el.innerHTML = \`
      <div class="row between">
        <span class="name">\${escapeHtml(o.kind)} · \${escapeHtml(o.scrutinyAction ?? "—")}</span>
        \${qBadge}
      </div>
      <div class="desc">\${escapeHtml(o.sessionId ?? "")} · \${escapeHtml(o.channel ?? "")} · \${escapeHtml(new Date(o.at).toLocaleString())}</div>
      <div class="row" style="gap:6px;margin-top:8px;">
        <button class="secondary" data-feedback="\${escapeHtml(o.refId ?? "")}" data-score="0.95">👍 great</button>
        <button class="secondary" data-feedback="\${escapeHtml(o.refId ?? "")}" data-score="0.5">😐 ok</button>
        <button class="secondary" data-feedback="\${escapeHtml(o.refId ?? "")}" data-score="0.1">👎 bad</button>
      </div>
    \`;
    list.appendChild(el);
  }
  list.querySelectorAll("[data-feedback]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const refId = btn.getAttribute("data-feedback");
      const score = Number(btn.getAttribute("data-score"));
      if (!refId) { btn.textContent = "no refId"; return; }
      try {
        await postJson("/feedback", { refId, qualityScore: score });
        btn.textContent = "✓ rated";
        btn.disabled = true;
      } catch (err) { btn.textContent = "[err] " + err.message; }
    });
  });
}

async function renderScrutiny() {
  const data = await fetchJson("/scrutiny/weights");
  const pending = await fetchJson("/scrutiny/pending").catch(() => null);
  const fitter = data.fitter ?? {};
  const weightsBlock = (w) => Object.entries(w ?? {})
    .map(([k, v]) => \`<div class="row between" style="font-size:12px;padding:3px 0;"><span class="muted">\${escapeHtml(k)}</span><strong>\${typeof v === "number" ? v.toFixed(3) : escapeHtml(String(v))}</strong></div>\`)
    .join("");
  main.innerHTML = \`
    <div class="pane">
      <h2>Scrutiny <span class="muted" style="font-size:14px;font-weight:400;">· cycle \${fitter.cycles ?? 0} · \${fitter.autoApply ? "auto-apply" : "warmup"}\${fitter.restoredWeightsAt ? \` · calibrated \${escapeHtml(new Date(fitter.restoredWeightsAt).toLocaleDateString())}\` : ""}</span></h2>
      <div class="row" style="gap:8px;margin-bottom:14px;">
        <button id="fitBtn">Run fit now</button>
      </div>
      <pre id="scrOut" class="ok" style="display:none;"></pre>

      <h3>Judges</h3>
      <div class="grid two" id="judges"></div>

      <h3>Fitter status</h3>
      <div class="grid stats">
        <div class="card"><span class="desc">Cycles run</span><div class="stat-value">\${fitter.cycles ?? 0}</div></div>
        <div class="card"><span class="desc">Warmup cycles</span><div class="stat-value">\${fitter.warmupCycles ?? 0}</div></div>
        <div class="card"><span class="desc">Pending proposals</span><div class="stat-value">\${fitter.pendingProposals ?? 0}</div></div>
        <div class="card"><span class="desc">Last run</span><div class="stat-value" style="font-size:14px;">\${fitter.lastRunAt ? escapeHtml(new Date(fitter.lastRunAt).toLocaleString()) : "—"}</div></div>
      </div>

      <h3>Pending proposals</h3>
      <div id="pendingList" class="grid"></div>
    </div>
  \`;
  const judges = $("judges");
  for (const [name, j] of Object.entries(data.weights ?? {})) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = \`<div class="row between"><span class="name">\${escapeHtml(name)}</span></div>
      <div class="desc" style="margin:8px 0 4px;">weights</div>\${weightsBlock(j.weights)}
      <div class="desc" style="margin:10px 0 4px;">thresholds</div>\${weightsBlock(j.thresholds)}\`;
    judges.appendChild(card);
  }
  const pl = $("pendingList");
  if (!pending || !pending.proposals?.length) {
    pl.innerHTML = '<div class="empty">No pending proposals.</div>';
  } else {
    for (const p of pending.proposals) {
      const c = document.createElement("div");
      c.className = "card";
      c.innerHTML = \`<div class="row between"><span class="name">cycle \${p.cycle}</span>
        <span class="badge \${p.applied ? "ok" : "warn"}">\${p.applied ? "applied" : "pending"}</span></div>
        <details style="margin-top:8px;"><summary class="desc">view weight deltas</summary><pre>\${escapeHtml(JSON.stringify(p.proposals, null, 2))}</pre></details>
        <div class="row" style="margin-top:8px;"><button class="secondary" data-apply="\${p.cycle}" \${p.applied ? "disabled" : ""}>\${p.applied ? "Applied" : "Apply"}</button></div>\`;
      pl.appendChild(c);
    }
    pl.querySelectorAll("[data-apply]").forEach((b) => b.addEventListener("click", async () => {
      await postJson(\`/scrutiny/pending/\${b.getAttribute("data-apply")}/apply\`, {});
      renderScrutiny();
    }));
  }
  const showOut = (text) => { const el = $("scrOut"); el.style.display = "block"; el.textContent = text; };
  $("fitBtn").addEventListener("click", async () => {
    showOut("fitting…");
    try { showOut(JSON.stringify(await postJson("/scrutiny/fit", {}), null, 2)); }
    catch (e) { showOut("[err] " + e.message); }
  });
}

async function renderHealth() {
  const a = await fetchJson("/audit");
  const sp = a.specialists ?? {};
  const mem = a.memory ?? { counts: {}, saturation: {}, principles: 0 };
  const upcoming = a.cron?.upcoming ?? [];
  const out7 = a.outcomes?.last7Days ?? null;
  const out30 = a.outcomes?.last30Days ?? null;
  const mcp = a.mcp ?? [];

  const findingCards = !a.findings?.length
    ? '<div class="empty">All systems nominal.</div>'
    : a.findings.map((f) => {
        const cls = f.severity === "warn" ? "warn" : f.severity === "err" ? "err" : "ok";
        return \`<div class="card"><div class="row between"><span class="name">\${escapeHtml(f.area)}</span><span class="badge \${cls}">\${escapeHtml(f.severity)}</span></div><div class="desc">\${escapeHtml(f.note)}</div></div>\`;
      }).join("");

  const upcomingCards = upcoming.length === 0
    ? '<div class="empty">Nothing scheduled.</div>'
    : upcoming.map((j) => \`<div class="card"><div class="row between"><span class="name">\${escapeHtml(j.name)}</span><span class="badge">\${escapeHtml(j.task)}</span></div><div class="desc">next: \${escapeHtml(new Date(j.nextRunAt).toLocaleString())}</div></div>\`).join("");

  const mcpCards = mcp.length === 0
    ? '<div class="empty">No MCP servers registered.</div>'
    : mcp.map((s) => \`<div class="card"><div class="row between"><span class="name">\${escapeHtml(s.name)}</span><span class="badge \${s.connected ? "ok" : ""}">\${s.connected ? "live" : "idle"}</span></div><div class="desc">\${s.tools} tool\${s.tools===1?"":"s"}</div></div>\`).join("");

  main.innerHTML = \`
    <div class="pane">
      <h2>Health</h2>

      <h3>Findings</h3>
      <div class="grid">\${findingCards}</div>

      <h3>Specialists</h3>
      <div class="grid stats">
        <div class="card"><span class="desc">Active</span><div class="stat-value">\${sp.active ?? 0}</div></div>
        <div class="card"><span class="desc">Retired</span><div class="stat-value muted">\${sp.retired ?? 0}</div></div>
        <div class="card"><span class="desc">Dormant >14d</span><div class="stat-value">\${sp.dormant ?? 0}</div></div>
        <div class="card"><span class="desc">Low quality</span><div class="stat-value">\${sp.lowQuality ?? 0}</div></div>
      </div>

      <h3>Memory</h3>
      <div class="grid stats">
        <div class="card"><span class="desc">Short tier</span><div class="stat-value">\${mem.counts.short ?? 0}</div><div class="desc">\${((mem.saturation.short ?? 0) * 100).toFixed(0)}% saturated</div></div>
        <div class="card"><span class="desc">Medium tier</span><div class="stat-value">\${mem.counts.medium ?? 0}</div><div class="desc">\${((mem.saturation.medium ?? 0) * 100).toFixed(0)}% saturated</div></div>
        <div class="card"><span class="desc">Long tier</span><div class="stat-value">\${mem.counts.long ?? 0}</div><div class="desc">\${((mem.saturation.long ?? 0) * 100).toFixed(0)}% saturated</div></div>
        <div class="card"><span class="desc">Principles</span><div class="stat-value">\${mem.principles ?? 0}</div></div>
      </div>

      <h3>Outcomes</h3>
      <div class="grid stats">
        <div class="card"><span class="desc">7-day avg quality</span><div class="stat-value">\${out7?.avgQuality ?? "—"}</div><div class="desc">\${out7?.resolved ?? 0} / \${out7?.total ?? 0} resolved</div></div>
        <div class="card"><span class="desc">30-day avg quality</span><div class="stat-value">\${out30?.avgQuality ?? "—"}</div><div class="desc">\${out30?.resolved ?? 0} / \${out30?.total ?? 0} resolved</div></div>
        <div class="card"><span class="desc">Pending (7d)</span><div class="stat-value">\${out7?.pending ?? 0}</div></div>
      </div>

      <h3>Upcoming cron</h3>
      <div class="grid">\${upcomingCards}</div>

      <h3>MCP</h3>
      <div class="grid">\${mcpCards}</div>
    </div>
  \`;
}

async function renderSuggestions(status = state.suggestionStatus ?? "pending") {
  // Live view of everything the proactive observer has proposed and is
  // waiting on the user to accept/reject. Tasks → Tasks tab, MCPs →
  // auto-register, automations → notes, knowledge → just FYI.
  // Plus: pending agent-initiated actions (catalog connects, daemon
  // restarts) that need explicit human approval before they run.
  const queueStatus = status === "deferred" ? "deferred" : "pending";
  state.suggestionStatus = queueStatus;
  const [list, pendingActions] = await Promise.all([
    fetchJson(\`/proactive/suggestions?status=\${encodeURIComponent(queueStatus)}\`).catch(() => []),
    queueStatus === "pending"
      ? fetchJson("/pending-actions?status=pending").catch(() => ({ actions: [] }))
      : Promise.resolve({ actions: [] })
  ]);
  const actions = pendingActions?.actions ?? [];
  const alternateStatus = queueStatus === "pending" ? "deferred" : "pending";
  const queueToggleHtml = \`
    <button class="secondary" id="suggestionQueueToggle">
      View \${alternateStatus}
    </button>
  \`;
  const bindQueueToggle = () => {
    $("suggestionQueueToggle")?.addEventListener("click", () => {
      renderSuggestions(alternateStatus);
    });
  };

  const pendingActionsHtml = actions.length === 0 ? "" : \`
    <h3 style="margin-top:8px;">Agent actions awaiting approval <span class="badge">\${actions.length}</span></h3>
    <p class="muted">The agent proposed these — they only run if you approve.</p>
    \${actions.map((a) => \`
      <div class="card" style="padding:14px; margin-bottom:10px;" data-pending-id="\${escapeHtml(a.id)}">
        <div style="display:flex; gap:8px; align-items:center;">
          <span style="font-size:18px;">🤖</span>
          <span style="font-weight:600;">\${escapeHtml(a.summary || a.toolName)}</span>
          <span class="badge">\${escapeHtml(a.toolName)}</span>
        </div>
        \${a.reason ? \`<div class="muted" style="margin-top:6px; font-size:12px;">\${escapeHtml(a.reason)}</div>\` : ""}
        <details open style="margin-top:6px;"><summary class="muted" style="font-size:11px;">args</summary><pre style="font-size:11px; margin-top:4px;">\${escapeHtml(JSON.stringify(a.args, null, 2))}</pre></details>
        <div class="muted" style="margin-top:4px; font-size:11px;">queued \${escapeHtml(new Date(a.createdAt).toLocaleString())}</div>
        <div class="row" style="gap:8px; margin-top:10px;">
          <button data-pending-action="approve">Approve & run</button>
          <button data-pending-action="deny" class="secondary">Deny</button>
        </div>
      </div>
    \`).join("")}
  \`;

  if ((!Array.isArray(list) || list.length === 0) && actions.length === 0) {
    main.innerHTML = \`
      <div class="pane">
        <div class="row between">
          <h2>Suggestions</h2>
          \${queueToggleHtml}
        </div>
        <div id="suggestionsPageChat"></div>
        <p class="muted">\${queueStatus === "deferred"
          ? "No deferred skill candidates."
          : "Nothing new to surface right now. The proactive observer and pattern miner will queue worthwhile proposals here."}</p>
        \${queueStatus === "pending"
          ? '<p class="muted">If you want to force a run now: <code>POST /proactive/observe</code>.</p>'
          : ""}
      </div>
    \`;
    bindQueueToggle();
    renderPageChatComposer(document.getElementById("suggestionsPageChat"), {
      placeholder: 'e.g. "What did you notice today?" or "ignore screenshots from Discord"',
      onAfterSend: async () => { await renderSuggestions(); }
    });
    return;
  }
  if (!Array.isArray(list) || list.length === 0) {
    // Only pending agent actions, no proactive suggestions.
    main.innerHTML = \`
      <div class="pane">
        <div class="row between">
          <h2>Suggestions</h2>
          \${queueToggleHtml}
        </div>
        <div id="suggestionsPageChat"></div>
        \${pendingActionsHtml}
      </div>
    \`;
    bindQueueToggle();
    renderPageChatComposer(document.getElementById("suggestionsPageChat"), {
      placeholder: 'e.g. "approve the Stripe MCP" or "deny it, I changed my mind"',
      onAfterSend: async () => { await renderSuggestions(); }
    });
    bindPendingActionButtons();
    return;
  }

  const card = (s) => {
    const icon = ({ task: "📋", skill: "✨", mcp: "🔌", automation: "⚙️", knowledge: "💡" })[s.category] ?? "🔔";
    const proposedAt = s.proposedAt ? new Date(s.proposedAt).toLocaleString() : "";
    const meta = [];
    if (s.category === "task") {
      meta.push(\`queue: \${s.taskQueue ?? "user"}\`);
      meta.push(\`bucket: \${s.taskBucket ?? "today"}\`);
    } else if (s.category === "mcp" && s.mcpId) {
      meta.push(\`catalog id: \${s.mcpId}\`);
    }
    // Story 4: source badge differentiates miner-detected patterns
    // (real activity signal, sometimes with count + confidence) from
    // observer's one-shot proposals (LLM read of the last 10 min).
    const sourceBadge = s.source === "pattern-miner"
      ? '<span class="ui-badge" title="Detected by activity pattern miner — observed multiple times.">pattern</span>'
      : s.source === "session-miner"
        ? '<span class="ui-badge" title="Detected by chat-session miner — recurring across conversations.">session</span>'
        : s.source === "weekly-observer"
          ? '<span class="ui-badge" title="Mid-horizon observer — multi-day project thread, not a single moment.">7-day</span>'
          : "";
    // Story 5: when high-confidence signals bypass the judge's pass=true
    // veto, badge it so the user knows the LLM tried to skip this but
    // the deterministic confidence floor kept it.
    const bypassBadge = s.judgeBypass
      ? '<span class="ui-badge ui-badge-accent" title="High-confidence signal — bypassed the LLM judge.">auto-passed</span>'
      : "";
    let sequenceMeta = null;
    if (s.sequence) {
      const conf = (s.sequence.confidence ?? 0).toFixed(2);
      const hourPart = s.sequence.startHour != null
        ? " · around " + String(s.sequence.startHour).padStart(2, "0") + ":00"
        : "";
      sequenceMeta = "observed " + s.sequence.count + "× · confidence " + conf + hourPart;
    }
    const isReviewableSkill = s.category === "skill" && [
      "pattern-miner",
      "session-miner",
      "recipe-memory"
    ].includes(s.source);
    const controls = isReviewableSkill
      ? \`
        <button data-action="accept">Accept</button>
        <button data-action="edit-toggle" class="secondary">Edit & Accept</button>
        <button data-action="defer" class="secondary">Defer</button>
        <button data-action="reject" class="secondary">Discard</button>
      \`
      : \`
        <button data-action="accept">Accept</button>
        <button data-action="dismiss" class="secondary">Dismiss</button>
        <button data-action="reject" class="secondary">Reject</button>
      \`;
    const editPanel = isReviewableSkill
      ? \`
        <div data-edit-panel style="display:none;margin-top:10px;">
          <label>Skill name</label>
          <input class="ui-input" data-edit-name value="\${escapeHtml(s.title ?? "")}">
          <label style="margin-top:8px;">Skill body</label>
          <textarea class="ui-textarea" data-edit-body rows="10">\${escapeHtml(s.draftBody ?? "")}</textarea>
          <div class="row" style="gap:8px;margin-top:8px;">
            <button data-action="edit-submit">Save edit & accept</button>
            <button data-action="edit-cancel" class="secondary">Cancel</button>
          </div>
        </div>
      \`
      : "";
    return \`
      <div class="card" style="padding:14px; margin-bottom:10px;" data-suggestion-id="\${s.id}">
        <div class="row between" style="align-items:flex-start; gap:8px;">
          <div style="flex:1; min-width:0;">
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
              <span style="font-size:18px;">\${icon}</span>
              <span style="font-weight:600;">\${escapeHtml(s.title || "(untitled)")}</span>
              <span class="badge">\${escapeHtml(s.category || "?")}</span>
              \${sourceBadge}
              \${bypassBadge}
            </div>
            <div class="muted" style="margin-top:6px; font-size:12px;">\${escapeHtml(s.rationale || "")}</div>
            \${meta.length > 0 ? \`<div class="muted" style="margin-top:4px; font-size:11px;">\${meta.map(escapeHtml).join(" · ")}</div>\` : ""}
            \${sequenceMeta ? \`<div class="muted" style="margin-top:4px; font-size:11px;">\${escapeHtml(sequenceMeta)}</div>\` : ""}
            \${proposedAt ? \`<div class="muted" style="margin-top:4px; font-size:11px;">proposed \${escapeHtml(proposedAt)}</div>\` : ""}
          </div>
        </div>
        <div class="row" style="gap:8px; margin-top:10px;">
          \${controls}
        </div>
        \${editPanel}
      </div>
    \`;
  };

  main.innerHTML = \`
    <div class="pane">
      <div class="row between">
        <h2>Suggestions <span class="badge">\${list.length}</span></h2>
        \${queueToggleHtml}
      </div>
      <div id="suggestionsPageChat"></div>
      <p class="muted">\${queueStatus === "deferred"
        ? "Deferred skill candidates are held for a later owner decision."
        : "Review proposals with their occurrence and confidence evidence before accepting, editing, deferring, or discarding them."}</p>
      \${list.map(card).join("")}
      \${pendingActionsHtml}
    </div>
  \`;
  bindQueueToggle();
  renderPageChatComposer(document.getElementById("suggestionsPageChat"), {
    placeholder: 'Talk to the agent about these…',
    onAfterSend: async () => { await renderSuggestions(); }
  });
  bindPendingActionButtons();

  document.querySelectorAll("[data-suggestion-id]").forEach((el) => {
    const id = el.dataset.suggestionId;
    el.querySelectorAll("[data-action]").forEach((b) => {
      b.addEventListener("click", async () => {
        const action = b.dataset.action;
        const editPanel = el.querySelector("[data-edit-panel]");
        if (action === "edit-toggle") {
          editPanel.style.display = "block";
          editPanel.querySelector("[data-edit-body]")?.focus();
          return;
        }
        if (action === "edit-cancel") {
          editPanel.style.display = "none";
          return;
        }
        try {
          const requestAction = action === "edit-submit" ? "edit" : action;
          const payload = action === "edit-submit"
            ? {
                name: editPanel.querySelector("[data-edit-name]")?.value ?? "",
                body: editPanel.querySelector("[data-edit-body]")?.value ?? ""
              }
            : {};
          const res = await postJson(
            \`/proactive/suggestions/\${encodeURIComponent(id)}/\${requestAction}\`,
            payload
          );
          if (action === "accept" && res.taskId) {
            showToast("✓ Task added — opening Tasks", true);
            setTimeout(() => switchTab("tasks"), 600);
          } else if (action === "accept" && res.registered) {
            showToast(\`✓ MCP \${res.registered} connected — opening MCP tab\`, true);
            setTimeout(() => switchTab("mcp"), 600);
          } else if (action === "accept") {
            showToast("✓ Accepted", true);
          } else if (action === "edit-submit") {
            showToast("Edited skill accepted", true);
          } else if (action === "defer") {
            showToast("Skill candidate deferred", true);
          } else if (action === "reject" && el.querySelector("[data-edit-panel]")) {
            showToast("Skill candidate discarded", true);
          } else {
            showToast(\`Suggestion \${action}d\`, true);
          }
          await renderSuggestions(queueStatus);
        } catch (err) {
          showToast("Action failed: " + err.message, false);
        }
      });
    });
  });
}

function bindPendingActionButtons() {
  document.querySelectorAll("[data-pending-id]").forEach((card) => {
    const id = card.dataset.pendingId;
    card.querySelectorAll("[data-pending-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const decision = btn.dataset.pendingAction;
        btn.disabled = true;
        const originalLabel = btn.textContent;
        btn.textContent = decision === "approve" ? "Running..." : "Denying...";
        try {
          const res = await postJson(\`/pending-actions/\${encodeURIComponent(id)}/\${decision}\`, {});
          if (decision === "approve") {
            const summary = res?.result?.note ?? res?.result?.message ?? \`Action ran (\${JSON.stringify(res?.result ?? res)})\`;
            showToast(\`✓ \${summary}\`, true);
          } else {
            showToast("Action denied.", true);
          }
          await renderSuggestions();
        } catch (err) {
          showToast(\`\${decision} failed: \${err.message}\`, false);
          btn.disabled = false;
          btn.textContent = originalLabel;
        }
      });
    });
  });
}

async function renderIntegrations() {
  const data = await fetchJson("/integrations/status").catch(() => ({ integrations: [], catalog: [], categories: [] }));
  const integrations = data.integrations ?? [];
  const catalog = data.catalog ?? [];
  const categories = data.categories ?? [];

  const catalogCard = (e) => {
    let badge;
    if (e.configured) {
      badge = '<span class="ui-badge ui-badge-accent">on</span>';
    } else if (e.status === "coming-soon") {
      badge = '<span class="ui-badge">soon</span>';
    } else {
      badge = '<span class="ui-badge">off</span>';
    }
    // Bearer-auth entries need an API key. Reveal an inline input here
    // when the env var isn't set yet — the click handler reads the value
    // from this field and POSTs it alongside the catalogId.
    const needsKey = e.connectable && !e.configured && e.apiKeyEnvVar && !e.apiKeyConfigured;
    const keyFieldId = \`cat-key-\${e.id}\`;
    let action;
    if (e.configured) {
      action = \`<a class="ui-btn ui-btn-ghost ui-btn-sm" href="/?tab=mcp">Manage →</a>\`;
    } else if (e.connectable) {
      action = \`<button class="ui-btn ui-btn-sm add-mcp-btn" data-catalog-id="\${escapeHtml(e.id)}" data-int-id="\${escapeHtml(e.id)}" \${needsKey ? \`data-key-field-id="\${keyFieldId}"\` : ""}>+ Connect</button>\`;
    } else {
      const auth = e.authType === "oauth" ? "OAuth coming soon" : "Coming soon";
      action = \`<span class="ui-meta">\${auth}</span>\`;
    }
    const keyField = needsKey
      ? \`
        <div style="margin-top: var(--space-2);">
          <label style="display:block; font-size:10px; color: var(--muted-foreground); margin-bottom: 3px;">\${escapeHtml(e.apiKeyEnvVar)}\${e.apiKeyHelp ? \` — \${escapeHtml(e.apiKeyHelp)}\` : ""}</label>
          <input class="ui-input" type="password" id="\${keyFieldId}" autocomplete="off" placeholder="paste your key" style="font-size: 12px;">
        </div>
      \`
      : "";
    return \`
      <div class="ui-card" style="display: flex; flex-direction: column; gap: var(--space-2);">
        <div style="display: flex; align-items: flex-start; gap: var(--space-2);">
          <div class="ui-grow">
            <div style="font-weight: 600; font-size: 13px; display:flex; align-items:center; gap:6px;"><span>\${escapeHtml(e.name)}</span><span class="badge mcp" style="font-size:9px;">MCP</span></div>
            <div class="ui-meta" style="margin-top: 2px;">\${escapeHtml(e.description ?? "")}</div>
            \${e.featured ? '<div class="ui-meta" style="margin-top:3px; opacity:.85;">↑ Also available as a non-MCP (direct API) integration above</div>' : ""}
          </div>
          \${badge}
        </div>
        \${keyField}
        <div>\${action}</div>
      </div>
    \`;
  };

  const pathBlock = (it, p) => {
    const status = p.configured
      ? '<span class="badge ok">on</span>'
      : '<span class="badge">off</span>';
    const lastSync = p.lastSyncedAt
      ? \`<div class="muted" style="font-size:11px; margin-top:4px;">last sync: \${escapeHtml(new Date(p.lastSyncedAt).toLocaleString())}</div>\`
      : "";
    const envBlock = p.envKeys?.length > 0
      ? \`<div class="muted" style="font-size:11px; margin-top:4px;">env: <code>\${p.envKeys.map(escapeHtml).join("</code> · <code>")}</code></div>\`
      : "";
    // Make the integration TYPE unmistakable: an MCP path vs a non-MCP
    // (direct API / file-drop) path. Two integrations can offer both.
    const kindBadge = p.kind === "mcp"
      ? '<span class="badge mcp">MCP</span>'
      : '<span class="badge muted">non-MCP</span>';
    let actions = "";
    let editForm = "";
    if (p.kind === "api" && p.envKeys?.length > 0) {
      const formId = \`form-\${it.id}-\${p.kind}\`;
      const editLabel = p.configured ? "Edit credentials" : "+ Add credentials";
      actions = \`<button class="edit-creds-btn" data-form-id="\${formId}" style="font-size:11px; padding:3px 8px;">\${editLabel}</button>\`;
      editForm = \`
        <form id="\${formId}" data-int-form class="edit-creds-form" style="display:none; margin-top:10px; padding:10px; background:rgba(255,255,255,.03); border-radius:6px;">
          \${p.envKeys.map((k) => \`
            <div style="margin-bottom:8px;">
              <label style="display:block; font-size:11px; margin-bottom:3px; color:var(--muted);">\${escapeHtml(k)}</label>
              <input type="\${k.includes("EMAIL") || k.includes("URL") || k.includes("FROM_NUMBER") || k.includes("USER_NAME") ? "text" : "password"}" name="\${escapeHtml(k)}" placeholder="\${p.configured ? "(leave blank to keep current)" : ""}" autocomplete="off" style="width:100%; padding:5px 7px; font-size:12px;">
            </div>
          \`).join("")}
          <div class="row" style="gap:6px; align-items:center;">
            <button type="submit" style="font-size:11px; padding:3px 10px;">Save</button>
            <button type="button" data-cancel="\${formId}" class="secondary" style="font-size:11px; padding:3px 10px;">Cancel</button>
            <span class="muted" style="font-size:11px;">Restart daemon afterwards from the menu bar to apply.</span>
          </div>
        </form>
      \`;
    } else if (p.kind === "mcp" && !p.configured) {
      actions = \`<button class="add-mcp-btn" data-catalog-id="\${escapeHtml(p.catalogId)}" data-int-id="\${escapeHtml(it.id)}" style="font-size:11px; padding:3px 8px;">+ Connect this MCP</button>\`;
    } else if (p.kind === "mcp" && p.configured) {
      actions = \`<a href="/?tab=mcp" style="font-size:11px;">Manage in MCP tab →</a>\`;
    } else if (p.kind === "folder" && p.configured) {
      actions = \`<a href="/?tab=tasks" style="font-size:11px;">View tasks →</a>\`;
    }
    return \`
      <div style="border:1px solid var(--line); border-radius:6px; padding:10px 12px; margin-top:6px;">
        <div class="row between" style="align-items:center; gap:8px;">
          <div style="flex:1; min-width:0;">
            <div style="font-weight:500; font-size:13px; display:flex; align-items:center; gap:6px;">\${kindBadge}<span>\${escapeHtml(p.label)}</span></div>
            \${p.detail ? \`<div class="muted" style="font-size:11px; margin-top:2px;">\${escapeHtml(p.detail)}</div>\` : ""}
            \${envBlock}
            \${lastSync}
          </div>
          <div style="display:flex; gap:8px; align-items:center; flex-shrink:0;">
            \${status}
            \${actions}
          </div>
        </div>
        \${editForm}
      </div>
    \`;
  };

  main.innerHTML = \`
    <div class="pane">
      <h2>Integrations</h2>
      <p class="muted">Every source, channel, and MCP in one place. Each row shows all the paths you can use — direct API, MCP, or file-drop. Click "+ Connect this MCP" to register one with one click, or set credentials in <a href="/setup">/setup</a> step 5 / <code>.openagi/.env</code>.</p>

      \${integrations.map((it) => \`
        <div class="card" style="padding:14px; margin-bottom:12px;">
          <div class="row between" style="align-items:flex-start; gap:10px;">
            <div style="flex:1; min-width:0;">
              <div style="font-weight:600; font-size:15px;">\${escapeHtml(it.name)}</div>
              <div class="muted" style="font-size:12px; margin-top:3px;">\${escapeHtml(it.description ?? "")}</div>
            </div>
            \${(it.paths ?? []).some((p) => p.configured) ? '<span class="badge ok">active</span>' : '<span class="badge">inactive</span>'}
          </div>
          \${(it.paths ?? []).map((p) => pathBlock(it, p)).join("")}
        </div>
      \`).join("")}

      \${catalog.length > 0 ? \`
        <h2 style="margin-top:30px;">Browse MCP catalog</h2>
        <p class="muted">More servers — connect with one click when an integration is "available", or watch this list for OAuth-pending entries.</p>
        \${categories.map((cat) => {
          const inCat = catalog.filter((e) => e.category === cat.id);
          if (inCat.length === 0) return "";
          return \`
            <div style="margin-top:18px;">
              <h3 style="font-size:13px; text-transform:uppercase; letter-spacing:0.5px; color:var(--muted); margin-bottom:8px;">\${escapeHtml(cat.name)}</h3>
              <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); gap:10px;">
                \${inCat.map((e) => catalogCard(e)).join("")}
              </div>
            </div>
          \`;
        }).join("")}
      \` : ""}
    </div>
  \`;

  document.querySelectorAll(".add-mcp-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const catalogId = btn.dataset.catalogId;
      const keyFieldId = btn.dataset.keyFieldId;
      const originalLabel = btn.textContent;
      let apiKey;
      if (keyFieldId) {
        const field = document.getElementById(keyFieldId);
        const v = field?.value?.trim();
        if (!v) {
          showToast("Paste the API key into the field above this button before connecting.", false);
          field?.focus();
          return;
        }
        apiKey = v;
      }
      btn.disabled = true;
      btn.textContent = "Connecting...";
      try {
        const result = await postJson("/integrations/connect-mcp", apiKey ? { catalogId, apiKey } : { catalogId });
        showToast(\`✓ Registered \${result.name ?? catalogId} MCP — opening MCP tab.\`, true);
        // If OAuth, the MCP page will show the auth URL via SSE.
        setTimeout(() => switchTab("mcp"), 800);
      } catch (err) {
        showToast(\`Connect failed: \${err.message}\`, false);
        btn.disabled = false;
        btn.textContent = originalLabel;
      }
    });
  });

  // Inline credential edit forms — show/hide and submit to /setup/save.
  document.querySelectorAll(".edit-creds-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const form = document.getElementById(btn.dataset.formId);
      if (!form) return;
      form.style.display = form.style.display === "none" ? "" : "none";
    });
  });
  document.querySelectorAll("[data-cancel]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const form = document.getElementById(btn.dataset.cancel);
      if (form) form.style.display = "none";
    });
  });
  document.querySelectorAll(".edit-creds-form").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const values = {};
      for (const [k, v] of fd.entries()) {
        const trimmed = String(v ?? "").trim();
        if (trimmed.length > 0) values[k] = trimmed;
      }
      if (Object.keys(values).length === 0) {
        showToast("Nothing to save (all fields empty)", false);
        return;
      }
      try {
        await postJson("/setup/save", values);
        showToast("✓ Credentials saved. Restart the daemon from the menu bar to apply.", true);
        await renderIntegrations();
      } catch (err) {
        showToast("Save failed: " + err.message, false);
      }
    });
  });
}

async function renderTasks() {
  state.taskFilter = state.taskFilter || { bucket: "all" };
  const data = await fetchJson("/tasks?limit=200").catch(() => ({ tasks: [], stats: {} }));
  const tasks = data.tasks ?? [];
  const stats = data.stats ?? {};
  const filterB = state.taskFilter.bucket;

  const taskRow = (t) => {
    const isOverdue = t.dueDate && Date.parse(t.dueDate) < Date.now() && t.status !== "completed";
    const dueDateStr = t.dueDate ? new Date(t.dueDate).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
    const sourceBadge = t.source && t.source !== "manual"
      ? (t.sourceUrl
          ? \`<a class="ui-badge" href="\${escapeHtml(t.sourceUrl)}" target="_blank" rel="noopener" style="text-decoration:none;">\${escapeHtml(t.source)} ↗</a>\`
          : \`<span class="ui-badge">\${escapeHtml(t.source)}</span>\`)
      : "";
    const titleStyle = t.status === "completed" ? "text-decoration:line-through; color:var(--muted-foreground);" : "";
    return \`
      <li data-task-id="\${t.id}" class="task ui-task-row">
        <input type="checkbox" \${t.status === "completed" ? "checked" : ""} data-action="toggle" class="ui-task-check">
        <div class="ui-grow">
          <div class="ui-row" style="gap: var(--space-2);">
            <span class="ui-task-title" style="\${titleStyle}">\${escapeHtml(t.title)}</span>
            <span class="ui-badge">\${t.bucket.replace("_", " ")}</span>
            \${t.priority >= 70 ? \`<span class="ui-badge ui-badge-err">P\${t.priority}</span>\` : ""}
            \${dueDateStr ? \`<span class="ui-badge \${isOverdue ? "ui-badge-err" : ""}">\${isOverdue ? "⏰ overdue " : "due "}\${dueDateStr}</span>\` : ""}
            \${sourceBadge}
          </div>
          \${t.description ? \`<div class="ui-meta" style="margin-top:4px;">\${escapeHtml(t.description.slice(0, 240))}</div>\` : ""}
          \${t.sourceMeta?.identifier ? \`<div class="ui-meta" style="margin-top:2px;">\${escapeHtml(t.sourceMeta.identifier)}\${t.sourceMeta.team ? " · " + escapeHtml(t.sourceMeta.team) : ""}\${t.sourceMeta.project ? " · " + escapeHtml(t.sourceMeta.project) : ""}</div>\` : ""}
          \${t.sourceMeta?.file ? \`<div class="ui-meta" style="margin-top:2px;">📎 \${escapeHtml(t.sourceMeta.file)} (line \${t.sourceMeta.line})</div>\` : ""}
        </div>
        <button data-action="delete" class="ui-btn ui-btn-ghost ui-btn-sm" title="Delete">×</button>
      </li>
    \`;
  };

  const inBucket = (t) => filterB === "all" || t.bucket === filterB;
  const userTasks = tasks.filter((t) => t.queue === "user" && inBucket(t));
  const agentTasks = tasks.filter((t) => t.queue === "agent" && inBucket(t));
  const userTotal = stats.user?.total ?? 0;
  const agentTotal = stats.agent?.total ?? 0;

  // Zero tasks EVER is almost always "no source is connected", not "inbox
  // zero". Diagnose it loudly instead of showing two empty sections: which
  // task sources are configured, and the last sync's skip reason when not.
  let gettingStarted = "";
  if (userTotal === 0 && agentTotal === 0) {
    const integ = await fetchJson("/integrations/status").catch(() => null);
    const taskSources = (integ?.integrations ?? []).filter((s) => ["linear", "buildbetter"].includes(s.id));
    const rows = taskSources.map((s) => {
      const api = (s.paths ?? []).find((p) => p.kind === "api");
      const ok = Boolean(api?.configured);
      const reason = api?.lastSync?.skipped ? api.lastSync.reason : (api?.lastSync?.signals?.skipped ? api.lastSync.signals.reason : null);
      const status = ok
        ? (reason ? \`connected — last sync skipped: \${escapeHtml(reason)}\` : "connected")
        : \`not connected (\${(api?.envKeys ?? []).slice(0, 1).map(escapeHtml).join("")} or MCP)\`;
      return \`<li style="margin:2px 0;"><strong>\${escapeHtml(s.name)}</strong>: <span class="\${ok && !reason ? "" : "ui-muted"}">\${status}</span></li>\`;
    }).join("");
    gettingStarted = \`
      <div class="card" style="margin-bottom: var(--space-4); border-left: 3px solid var(--warn, #d4a72c); padding: var(--space-3);">
        <div style="font-weight:600; margin-bottom:4px;">No tasks yet — here's why</div>
        <ul style="margin:4px 0 8px 16px; padding:0; font-size:13px;">\${rows || "<li>No task sources detected.</li>"}</ul>
        <div class="ui-meta">Connect a source in <a href="/?tab=integrations">Integrations</a>, drop .md/.txt files in ~/.openagi/inbox, or just tell the agent below: "remind me to…"</div>
      </div>\`;
  }

  main.innerHTML = \`
    <div class="pane">
      <h2>Tasks</h2>
      \${gettingStarted}
      <p class="ui-muted">Talk to the agent below to add, complete, or rearrange tasks. Or click checkboxes directly. <strong>My tasks</strong> are what you should do; <strong>Agent tasks</strong> are what Cerberus is working on for you.</p>

      <div id="tasksPageChat"></div>

      <div class="ui-row" style="margin-bottom: var(--space-4);">
        <span class="ui-meta">bucket:</span>
        \${["all", "today", "this_week", "this_month", "this_quarter", "this_year", "someday", "done"].map((b) => \`<button class="ui-btn \${filterB === b ? "" : "ui-btn-ghost"} ui-btn-sm" data-bf="\${b}">\${b.replace(/_/g, " ")}</button>\`).join("")}
      </div>

      <section class="ui-section">
        <div class="ui-section-header">
          <h3>My tasks</h3>
          <span class="ui-section-meta">· \${userTotal} total</span>
        </div>
        \${userTasks.length === 0
          ? \`<div class="ui-empty">Nothing here. Try saying "remind me to call Sarah tomorrow" or "add a task to fix the mouse bug".</div>\`
          : \`<ul class="ui-task-list">\${userTasks.map(taskRow).join("")}</ul>\`}
      </section>

      <section class="ui-section">
        <div class="ui-section-header">
          <h3>Agent tasks</h3>
          <span class="ui-section-meta">· \${agentTotal} total</span>
        </div>
        <p class="ui-meta" style="margin: 0 0 var(--space-2);">Things Cerberus has committed to do for you (or that the proactive observer queued).</p>
        \${agentTasks.length === 0
          ? \`<div class="ui-empty">No agent tasks. The agent will queue work here when it picks something up via the proactive observer or via "Cerberus, please look into X" in chat.</div>\`
          : \`<ul class="ui-task-list">\${agentTasks.map(taskRow).join("")}</ul>\`}
      </section>
    </div>
  \`;

  renderPageChatComposer(document.getElementById("tasksPageChat"), {
    placeholder: 'e.g. "Add a task to fix the mouse bug today" or "show me what\\'s overdue"',
    onAfterSend: async () => { await renderTasks(); }
  });

  document.querySelectorAll("[data-bf]").forEach((b) => b.addEventListener("click", () => { state.taskFilter.bucket = b.dataset.bf; renderTasks(); }));

  document.querySelectorAll(".task").forEach((el) => {
    const id = el.dataset.taskId;
    el.querySelector('[data-action="toggle"]')?.addEventListener("change", async (e) => {
      if (e.target.checked) {
        await fetch(\`/tasks/\${id}/complete\`, { method: "POST", headers: projectHeaders({ "content-type": "application/json" }), credentials: "include", body: "{}" });
      } else {
        await fetch(\`/tasks/\${id}\`, { method: "PATCH", headers: projectHeaders({ "content-type": "application/json" }), credentials: "include", body: JSON.stringify({ status: "pending", bucket: "today" }) });
      }
      await renderTasks();
    });
    el.querySelector('[data-action="delete"]')?.addEventListener("click", async () => {
      if (!confirm("Delete this task?")) return;
      await fetch(\`/tasks/\${id}\`, { method: "DELETE", headers: projectHeaders(), credentials: "include" });
      await renderTasks();
    });
  });
}

async function renderToday() {
  // Story 7: the daily recap view. Pulls the same data the daily_recap
  // tool returns and renders it as a single-page view. Date picker lets
  // the user scroll back to past days; on mount, defaults to today.
  const qsDate = new URLSearchParams(window.location.search).get("date");
  const today = new Date().toISOString().slice(0, 10);
  const date = qsDate || today;
  const isTodayView = date === new Date().toISOString().slice(0, 10);
  const [data, clarifications, planResp, drafts, chStatus] = await Promise.all([
    fetchJson("/recap/daily?date=" + encodeURIComponent(date)).catch(() => null),
    fetchJson("/tasks/clarifications?status=pending").catch(() => []),
    isTodayView ? fetchJson("/plan/daily").catch(() => null) : Promise.resolve(null),
    isTodayView ? fetchJson("/drafts?status=pending").catch(() => []) : Promise.resolve([]),
    isTodayView ? fetchJson("/channels").catch(() => null) : Promise.resolve(null)
  ]);
  // Which real outbound transports exist? Only offer "Send" for these;
  // email has no native channel (the user copies it into their mail client).
  const sendChannels = [];
  if (chStatus?.telegram?.configured) sendChannels.push("telegram");
  if (!data) {
    main.innerHTML = '<div class="pane"><h2>Today</h2><div class="ui-empty">Couldn\\'t load today\\'s recap.</div></div>';
    return;
  }
  const r = data.recap;

  // "Your day" — the morning plan. Only for today; collapses when empty.
  const plan = planResp?.plan ?? null;
  const showPlan = date === today && plan && (plan.focus?.length || plan.agentWillDo?.length || plan.calendar?.length || plan.timeSensitive?.length);
  const planHtml = !showPlan ? "" : \`
    <section class="ui-section" id="planSection">
      <div class="ui-section-header"><h3>🗓 Your day</h3>\${plan.synthesized ? '<span class="ui-section-meta">· planned</span>' : ""}</div>
      \${plan.note ? \`<div class="ui-meta" style="margin-bottom: var(--space-2);">\${escapeHtml(plan.note)}</div>\` : ""}
      \${(plan.timeSensitive?.length ?? 0) === 0 ? "" : \`<div class="ui-row" style="flex-wrap:wrap; gap:var(--space-1); margin-bottom:var(--space-2);">\${plan.timeSensitive.map((s) => \`<span class="ui-badge ui-badge-accent">⚠️ \${escapeHtml(s)}</span>\`).join("")}</div>\`}
      \${(plan.calendar?.length ?? 0) === 0 ? "" : \`<div class="ui-meta" style="margin-bottom:6px;">📅 \${plan.calendar.slice(0,6).map((e) => escapeHtml((e.allDay ? "all day" : new Date(e.start).toISOString().slice(11,16)) + " " + e.summary)).join(" · ")}</div>\`}
      \${(plan.focus?.length ?? 0) === 0 ? "" : \`<div style="font-weight:600; margin:4px 0;">🎯 Focus</div><ul class="ui-stack" style="list-style:none; padding-left:0; gap:4px;">\${plan.focus.map((f) => \`<li>\${escapeHtml(f.title)}\${f.why ? \` <span class="ui-meta">— \${escapeHtml(f.why)}</span>\` : ""}</li>\`).join("")}</ul>\`}
      \${(() => {
        // Prefer the REAL queued agent tasks (with live status) over the
        // freshly-recomputed proposal, so the user sees drafted vs pending.
        const queued = plan.queuedActions ?? [];
        const statusIcon = (s) => s === "completed" ? "✅" : s === "in_progress" ? "⏳" : "•";
        const statusLabel = (s) => s === "completed" ? "drafted" : s === "in_progress" ? "working" : "queued";
        if (queued.length) {
          return \`<div style="font-weight:600; margin:8px 0 4px;">🤖 I'll handle</div><ul class="ui-stack" style="list-style:none; padding-left:0; gap:4px;">\${queued.map((a) => \`<li>\${statusIcon(a.status)} \${escapeHtml(a.title)} <span class="ui-meta">— \${statusLabel(a.status)}</span></li>\`).join("")}</ul>\`;
        }
        if ((plan.agentWillDo?.length ?? 0) === 0) return "";
        return \`<div style="font-weight:600; margin:8px 0 4px;">🤖 I'll handle</div><ul class="ui-stack" style="list-style:none; padding-left:0; gap:4px;">\${plan.agentWillDo.map((a) => \`<li>\${escapeHtml(a.action)}\${a.detail ? \` <span class="ui-meta">— \${escapeHtml(a.detail)}</span>\` : ""}</li>\`).join("")}</ul>\`;
      })()}
    </section>
  \`;

  // "Needs your call" — the clarification queue. Only shown for today (the
  // questions are about what just happened, not a historical date).
  const showClarify = date === today && Array.isArray(clarifications) && clarifications.length > 0;
  const clarifyHtml = !showClarify ? "" : \`
    <section class="ui-section" id="clarifySection">
      <div class="ui-section-header"><h3>❓ Needs your call</h3><span class="ui-section-meta">· \${clarifications.length}</span></div>
      <ul class="ui-stack" style="list-style:none; padding-left:0; gap: var(--space-2);">
        \${clarifications.map((c) => \`
          <li class="ui-card" data-clar="\${escapeHtml(c.id)}" style="padding: var(--space-3);">
            <div style="font-weight:600;">\${escapeHtml(c.question)}</div>
            \${c.context ? \`<div class="ui-meta" style="margin:4px 0;">\${escapeHtml(c.context)}\${Array.isArray(c.sources) && c.sources.length ? " · via " + escapeHtml(c.sources.join("+")) : ""}</div>\` : ""}
            <div class="ui-row" style="gap: var(--space-2); margin-top: var(--space-2); flex-wrap:wrap;">
              <button class="ui-btn ui-btn-accent" data-clar-answer="yes" data-id="\${escapeHtml(c.id)}">Yes, done</button>
              <button class="ui-btn" data-clar-answer="in_progress" data-id="\${escapeHtml(c.id)}">Still working</button>
              <button class="ui-btn" data-clar-answer="no" data-id="\${escapeHtml(c.id)}">Not yet</button>
              <button class="ui-btn ui-btn-ghost" data-clar-answer="dropped" data-id="\${escapeHtml(c.id)}">Dropped it</button>
            </div>
          </li>
        \`).join("")}
      </ul>
    </section>
  \`;

  // "Drafts for review" — agent-produced artifacts awaiting approval.
  const draftKindIcon = { email: "✉️", message: "💬", doc: "📄", outline: "🗒", reply: "↩️", other: "📝" };
  const showDrafts = date === today && Array.isArray(drafts) && drafts.length > 0;
  const draftsHtml = !showDrafts ? "" : \`
    <section class="ui-section" id="draftsSection">
      <div class="ui-section-header"><h3>📝 Drafts for review</h3><span class="ui-section-meta">· \${drafts.length}</span></div>
      <ul class="ui-stack" style="list-style:none; padding-left:0; gap: var(--space-2);">
        \${drafts.map((d) => \`
          <li class="ui-card" data-draft="\${escapeHtml(d.id)}" style="padding: var(--space-3);">
            <div style="font-weight:600;">\${draftKindIcon[d.kind] || "📝"} \${escapeHtml(d.title)}\${d.recipient ? \` <span class="ui-meta">→ \${escapeHtml(d.recipient)}</span>\` : ""}</div>
            <textarea class="ui-input" data-draft-body="\${escapeHtml(d.id)}" rows="6" style="width:100%; margin:var(--space-2) 0; font-family:inherit;">\${escapeHtml(d.body)}</textarea>
            <div class="ui-meta" style="margin-bottom:6px;">Draft only — nothing has been sent. Approving marks it ready; sending transmits via a real channel.</div>
            <div class="ui-row" style="gap: var(--space-2); flex-wrap:wrap; align-items:center;">
              <button class="ui-btn ui-btn-accent" data-draft-action="approve" data-id="\${escapeHtml(d.id)}">Approve</button>
              <button class="ui-btn" data-draft-action="save" data-id="\${escapeHtml(d.id)}">Save edits</button>
              <button class="ui-btn ui-btn-ghost" data-draft-action="discard" data-id="\${escapeHtml(d.id)}">Discard</button>
              \${sendChannels.length === 0 ? "" : \`
                <span class="ui-meta" style="margin-left:auto;">Send via</span>
                <input class="ui-input" data-draft-target="\${escapeHtml(d.id)}" placeholder="\${d.recipient ? escapeHtml(d.recipient) : "recipient"}" style="width:auto; min-width:120px;">
                \${sendChannels.map((ch) => \`<button class="ui-btn" data-draft-send="\${escapeHtml(ch)}" data-id="\${escapeHtml(d.id)}">✈️ Telegram</button>\`).join("")}
              \`}
            </div>
          </li>
        \`).join("")}
      </ul>
    </section>
  \`;

  const section = (title, rows, renderRow) => rows.length === 0 ? "" : \`
    <section class="ui-section">
      <div class="ui-section-header"><h3>\${title}</h3><span class="ui-section-meta">· \${rows.length}</span></div>
      <ul class="ui-stack" style="list-style:none; padding-left:0; gap: var(--space-1);">\${rows.map(renderRow).join("")}</ul>
    </section>
  \`;

  main.innerHTML = \`
    <div class="pane">
      <div class="ui-row" style="justify-content: space-between; align-items: flex-start; margin-bottom: var(--space-3);">
        <div>
          <h2 style="margin: 0;">\${escapeHtml(r.date)}</h2>
          <div class="ui-meta">What you got done.</div>
        </div>
        <input type="date" id="todayDate" value="\${escapeHtml(date)}" class="ui-input" style="width: auto;">
      </div>

      <div class="ui-row" style="gap: var(--space-2); margin-bottom: var(--space-4);">
        <span class="ui-badge ui-badge-accent">\${r.counts.completedTasks ?? 0} tasks</span>
        <span class="ui-badge">\${r.counts.skillRuns ?? 0} skill runs</span>
        <span class="ui-badge">\${r.counts.approvedActions ?? 0} agent actions</span>
        \${r.activity?.hoursTracked ? \`<span class="ui-badge">\${r.activity.hoursTracked}h tracked</span>\` : ""}
      </div>

      \${planHtml}

      \${clarifyHtml}

      \${draftsHtml}

      \${section("✅ Completed", r.completedTasks, (t) => \`<li>\${escapeHtml(t.title)}\${t.queue === "agent" ? ' <span class="ui-meta">(agent)</span>' : ""}</li>\`)}
      \${section("✨ Skills run", r.skillRuns, (s) => \`<li>\${escapeHtml(s.skill ?? "(unknown)")}\${typeof s.qualityScore === "number" ? \` <span class="ui-meta">quality \${s.qualityScore.toFixed(2)}</span>\` : ""}</li>\`)}
      \${section("🤖 Agent actions approved", r.approvedActions, (a) => \`<li>\${escapeHtml(a.summary ?? a.toolName)}</li>\`)}
      \${(r.activity?.topApps?.length ?? 0) === 0 ? "" : \`
        <section class="ui-section">
          <div class="ui-section-header"><h3>⏱ Time</h3></div>
          <div class="ui-row" style="flex-wrap: wrap; gap: var(--space-2);">
            \${r.activity.topApps.map((a) => \`<span class="ui-badge"><strong>\${escapeHtml(a.app)}</strong> · \${a.hours}h</span>\`).join("")}
          </div>
        </section>
      \`}
      \${section("🧵 Themes", r.themes, (t) => \`<li>\${escapeHtml(t)}</li>\`)}
      \${section("🔓 Unblocked", r.unblocked, (u) => \`<li>\${escapeHtml(u.title)}</li>\`)}

      \${(r.counts.completedTasks ?? 0) + (r.counts.skillRuns ?? 0) + (r.counts.approvedActions ?? 0) === 0 && (r.activity?.hoursTracked ?? 0) < 0.5
        ? '<div class="ui-empty">Quiet day. Nothing logged.</div>'
        : ""}
    </div>
  \`;

  document.getElementById("todayDate")?.addEventListener("change", (e) => {
    const newDate = e.target.value;
    const url = new URL(window.location.href);
    url.searchParams.set("tab", "today");
    url.searchParams.set("date", newDate);
    history.replaceState(null, "", url.toString());
    renderToday();
  });

  // Clarification quick-answers. One tap resolves the task + records the
  // outcome server-side, then re-renders so the question disappears.
  main.querySelectorAll("[data-clar-answer]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      const answer = btn.getAttribute("data-clar-answer");
      btn.closest("[data-clar]")?.style && (btn.closest("[data-clar]").style.opacity = "0.5");
      try {
        await fetch("/tasks/clarifications/" + encodeURIComponent(id) + "/answer", {
          method: "POST",
          headers: projectHeaders({ "content-type": "application/json" }),
          credentials: "include",
          body: JSON.stringify({ answer })
        });
        showToast("Thanks — updated.", true);
      } catch { showToast("Couldn't save that.", false); }
      renderToday();
    });
  });

  // Draft review actions. "Save edits" PATCHes the body without resolving;
  // approve/discard resolve. Approving never sends — it only marks ready.
  main.querySelectorAll("[data-draft-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      const action = btn.getAttribute("data-draft-action");
      const bodyEl = main.querySelector('[data-draft-body="' + id + '"]');
      try {
        if (action === "save") {
          await fetch("/drafts/" + encodeURIComponent(id), {
            method: "PATCH",
            headers: projectHeaders({ "content-type": "application/json" }),
            credentials: "include",
            body: JSON.stringify({ body: bodyEl ? bodyEl.value : undefined })
          });
          showToast("Draft saved.", true);
          return; // keep it in the queue for further edits / approval
        }
        // Approve persists any in-progress edits first, then resolves.
        if (action === "approve" && bodyEl) {
          await fetch("/drafts/" + encodeURIComponent(id), {
            method: "PATCH", headers: projectHeaders({ "content-type": "application/json" }), credentials: "include",
            body: JSON.stringify({ body: bodyEl.value })
          });
        }
        await fetch("/drafts/" + encodeURIComponent(id) + "/" + action, {
          method: "POST",
          headers: projectHeaders(),
          credentials: "include"
        });
        showToast(action === "approve" ? "Approved — ready to use." : "Discarded.", true);
      } catch { showToast("Couldn't update the draft.", false); }
      renderToday();
    });
  });

  // Send a draft through a real channel — explicit, confirmed, transmits.
  main.querySelectorAll("[data-draft-send]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      const channel = btn.getAttribute("data-draft-send");
      const targetEl = main.querySelector('[data-draft-target="' + id + '"]');
      const bodyEl = main.querySelector('[data-draft-body="' + id + '"]');
      const target = (targetEl && targetEl.value.trim()) || "";
      if (!target) { showToast("Enter a recipient first.", false); return; }
      if (!confirm("Send this draft via " + channel + " to " + target + "? This transmits for real.")) return;
      try {
        // Persist any edits to the body first so we send what's on screen.
        if (bodyEl) {
          await fetch("/drafts/" + encodeURIComponent(id), {
            method: "PATCH", headers: projectHeaders({ "content-type": "application/json" }), credentials: "include",
            body: JSON.stringify({ body: bodyEl.value })
          });
        }
        const resp = await fetch("/drafts/" + encodeURIComponent(id) + "/send", {
          method: "POST", headers: projectHeaders({ "content-type": "application/json" }), credentials: "include",
          body: JSON.stringify({ channel, target })
        });
        if (resp.ok) showToast("Sent via " + channel + ".", true);
        else { const e = await resp.json().catch(() => ({})); showToast("Send failed: " + (e.error || resp.status), false); }
      } catch { showToast("Send failed.", false); }
      renderToday();
    });
  });
}

const OPS_CATEGORY_META = {
  skills: { icon: "🧰", label: "skills" },
  learning: { icon: "🧠", label: "learning" },
  tools: { icon: "⚙️", label: "tools" },
  "computer-use": { icon: "🖥️", label: "computer use" },
  vision: { icon: "👁️", label: "vision" },
  debug: { icon: "🧪", label: "debug" },
  system: { icon: "📡", label: "system" }
};
const OPS_FILTERS = ["all", "skills", "learning", "tools", "computer-use", "vision", "debug", "system"];

function opsMeta(category) {
  return OPS_CATEGORY_META[category] ?? OPS_CATEGORY_META.system;
}

function opsMakeEvent(category, title, detail = "", tone = "info", at = null) {
  return {
    id: String(Date.now()) + "-" + Math.random().toString(16).slice(2),
    at: at ?? new Date().toISOString(),
    category,
    title: String(title ?? ""),
    detail: String(detail ?? ""),
    tone
  };
}

function opsPush(category, title, detail = "", tone = "info", at = null) {
  if (state.ops.paused) {
    state.ops.deferred += 1;
    if (state.tab === "ops") paintOps();
    return;
  }
  state.ops.events.unshift(opsMakeEvent(category, title, detail, tone, at));
  if (state.ops.events.length > 180) state.ops.events.length = 180;
  if (state.tab === "ops") paintOps();
}

async function seedOps() {
  const [skills, history, computer, runs] = await Promise.all([
    fetchJson("/skills").catch(() => []),
    fetchJson("/skills/history?limit=30").catch(() => ({ edits: [] })),
    fetchJson("/computer-use/log?limit=50").catch(() => ({ sessions: [], actions: [], stats: {} })),
    fetchJson("/runs?limit=25").catch(() => ({ runs: [] }))
  ]);
  const seeded = [];
  const add = (category, title, detail, tone, at) => {
    seeded.push(opsMakeEvent(category, title, detail, tone, at));
  };

  if (Array.isArray(skills) && skills.length > 0) {
    const used = skills.filter((skill) => ((skill.stats?.runs ?? 0) + (skill.stats?.views ?? 0)) > 0).length;
    add("skills", skills.length + " skills loaded", used + " have recorded usage; Skills tab has full bodies, stats, and edit history.", "info");
  }
  for (const edit of history.edits ?? []) {
    add(
      "learning",
      "Skill " + String(edit.action ?? "edited") + ": " + String(edit.skill ?? "unknown"),
      [edit.by ? "by " + edit.by : null, edit.summary ?? null].filter(Boolean).join(" · "),
      "think",
      edit.at ?? null
    );
  }
  for (const session of computer.sessions ?? []) {
    add(
      "computer-use",
      "Computer-use session " + String(session.status ?? "recorded"),
      [session.goal ?? null, session.surface ? "surface: " + session.surface : null].filter(Boolean).join(" · "),
      session.status === "aborted" ? "err" : session.status === "active" ? "think" : "ok",
      session.endedAt ?? session.startedAt ?? null
    );
  }
  for (const action of (computer.actions ?? []).slice(-30)) {
    add(
      "computer-use",
      "Computer-use " + String(action.kind ?? "action"),
      [action.status ?? null, action.reasoning ?? null].filter(Boolean).join(" · "),
      action.status === "failed" ? "err" : action.mutating ? "think" : "info",
      action.executedAt ?? action.createdAt ?? null
    );
  }
  for (const run of runs.runs ?? []) {
    add(
      "debug",
      "Run " + String(run.kind ?? "event") + ": " + String(run.status ?? "recorded"),
      [run.name ?? null, run.id ?? null, run.summary ?? null].filter(Boolean).join(" · "),
      run.status === "failed" || run.status === "error" ? "err" : "info",
      run.startedAt ?? run.at ?? run.createdAt ?? null
    );
  }
  seeded.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  state.ops.events = seeded.slice(0, 180);
}

async function renderOps() {
  if (!state.ops.seeded) {
    state.ops.seeded = true;
    await seedOps().catch(() => {});
  }
  paintOps();
}

function opsStat(value, label) {
  return '<div class="ops-stat"><div class="ops-num">' + escapeHtml(value) + '</div><div class="ops-label">' + escapeHtml(label) + '</div></div>';
}

function opsEventHtml(event) {
  const meta = opsMeta(event.category);
  const when = (() => {
    const date = new Date(event.at);
    return Number.isNaN(date.getTime()) ? String(event.at ?? "") : date.toLocaleTimeString();
  })();
  return '<div class="ops-event" data-tone="' + escapeHtml(event.tone) + '">'
    + '<div class="ops-time">' + escapeHtml(when) + '</div>'
    + '<div><span class="ops-cat">' + meta.icon + ' ' + escapeHtml(meta.label) + '</span>'
    + '<span class="ops-title">' + escapeHtml(event.title) + '</span>'
    + (event.detail ? '<div class="ops-detail">' + escapeHtml(event.detail) + '</div>' : "")
    + '</div></div>';
}

function paintOps() {
  if (state.tab !== "ops") return;
  const filter = state.ops.filter;
  const events = state.ops.events.filter((event) => filter === "all" || event.category === filter);
  const count = (category) => state.ops.events.filter((event) => event.category === category).length;
  const filterButtons = OPS_FILTERS.map((name) => {
    const meta = name === "all" ? { icon: "✦", label: "all" } : opsMeta(name);
    const cls = name === filter ? "ops-filter active" : "ops-filter";
    return '<button type="button" class="' + cls + '" data-ops-filter="' + escapeHtml(name) + '">' + meta.icon + ' ' + escapeHtml(meta.label) + '</button>';
  }).join("");
  main.innerHTML = '<div class="pane">'
    + '<div class="row between" style="align-items:flex-start;gap:16px;">'
    + '<div><h2>Ops</h2><p class="muted">Live visibility into skill use, learning, edits, computer-use, vision, tools, and debug/runtime events.</p></div>'
    + '<div class="row" style="gap:8px;flex-wrap:wrap;">'
    + '<button type="button" class="ui-btn ui-btn-sm" id="opsPause">' + (state.ops.paused ? "▶ Resume" : "⏸ Pause") + '</button>'
    + '<button type="button" class="ui-btn ui-btn-sm" id="opsRefresh">↻ Reseed</button>'
    + '<button type="button" class="ui-btn ui-btn-sm ui-btn-destructive" id="opsClear">Clear</button>'
    + '</div></div>'
    + '<div class="ops-grid">'
    + opsStat(state.ops.events.length, "buffered events")
    + opsStat(count("skills") + count("learning"), "skill + learning")
    + opsStat(count("computer-use") + count("vision"), "computer + vision")
    + opsStat(count("debug"), "debug")
    + opsStat(state.ops.paused ? state.ops.deferred : 0, "paused events")
    + '</div>'
    + '<div class="ops-toolbar">' + filterButtons + '</div>'
    + '<div class="ops-feed" id="opsFeed">'
    + (events.length > 0
      ? events.map(opsEventHtml).join("")
      : '<div class="empty">No events in this lane yet. Run a skill, attach an image, start computer-use, or trigger a tool turn.</div>')
    + '</div></div>';
  document.querySelectorAll("[data-ops-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.ops.filter = btn.dataset.opsFilter ?? "all";
      paintOps();
    });
  });
  $("opsPause")?.addEventListener("click", () => {
    state.ops.paused = !state.ops.paused;
    if (!state.ops.paused) state.ops.deferred = 0;
    paintOps();
  });
  $("opsRefresh")?.addEventListener("click", async () => {
    state.ops.seeded = false;
    state.ops.events = [];
    state.ops.deferred = 0;
    await renderOps();
  });
  $("opsClear")?.addEventListener("click", () => {
    state.ops.events = [];
    state.ops.deferred = 0;
    paintOps();
  });
}

function opsSse(type, rawEvent) {
  let data = {};
  try { data = JSON.parse(rawEvent.data); } catch { return; }
  if (type === "skill-use") {
    const skill = String(data.skill ?? "unknown");
    const mode = data.mode === "run" ? "run" : "view";
    opsPush("skills", "Skill " + (mode === "run" ? "run" : "loaded") + ": " + skill, data.at ?? null, mode === "run" ? "ok" : "info", data.at ?? null);
  } else if (type === "skill-edit") {
    opsPush(
      "learning",
      "Skill " + String(data.action ?? "edited") + ": " + String(data.skill ?? "unknown"),
      [data.by ? "by " + data.by : null, data.summary ?? null].filter(Boolean).join(" · "),
      "think",
      data.at ?? null
    );
  } else if (
    type === "skill-candidate"
    || type === "skill-candidate-proposed"
  ) {
    const evidence = type === "skill-candidate-proposed"
      ? [
          data.occurrences ? "observed " + data.occurrences + " times" : null,
          typeof data.confidence === "number"
            ? "confidence " + data.confidence.toFixed(2)
            : null
        ].filter(Boolean).join(" / ")
      : String(data.rationale ?? data.description ?? "").slice(0, 240);
    opsPush(
      "learning",
      "Skill candidate: " + String(data.title ?? data.name ?? "untitled"),
      evidence,
      "think"
    );
  } else if (type === "background-review") {
    const details = [
      data.memoriesAdded ? data.memoriesAdded + " memories" : null,
      data.duplicatesSkipped ? data.duplicatesSkipped + " duplicates merged" : null,
      data.skillPending ? "skill proposal: " + (data.skillTitle ?? "untitled") : null
    ].filter(Boolean).join(" · ");
    if (details) opsPush("learning", "Background review", details, "info");
  } else if (type === "vision") {
    const count = Number(data.count) || 1;
    opsPush("vision", "Vision input received", count + " image" + (count === 1 ? "" : "s") + (data.source ? " · " + data.source : ""), "info", data.at ?? null);
  } else if (type === "computer-use") {
    if (data.kind === "session-start") {
      const session = data.session ?? {};
      opsPush("computer-use", "Computer-use session started", [session.goal ?? null, session.surface ? "surface: " + session.surface : null].filter(Boolean).join(" · "), "think");
    } else if (data.kind === "session-end") {
      const session = data.session ?? {};
      opsPush("computer-use", "Computer-use session " + String(session.status ?? "ended"), session.endReason ?? "", session.status === "aborted" ? "err" : "ok", session.endedAt ?? null);
    } else if (data.kind === "action-record" && data.action?.mutating) {
      opsPush("computer-use", "Computer-use action: " + String(data.action.kind ?? "unknown"), data.action.reasoning ?? "", "think", data.action.createdAt ?? null);
    } else if (data.kind === "action-result") {
      const action = data.action ?? {};
      if (action.status === "failed" || action.mutating) {
        opsPush("computer-use", "Computer-use " + String(action.kind ?? "action") + ": " + String(action.status ?? "finished"), action.error ?? action.reasoning ?? "", action.status === "failed" ? "err" : "ok", action.executedAt ?? null);
      }
    }
  } else if (type === "agent-activity") {
    if (data.phase === "start" && data.name) {
      opsPush("tools", "Tool started: " + String(data.name), [data.channel ?? null, data.agentId ? "agent: " + data.agentId : null].filter(Boolean).join(" · "), "think");
    } else if (data.phase === "end" && data.ok === false) {
      opsPush("tools", "Tool failed: " + String(data.name ?? "unknown"), data.channel ?? "", "err");
    } else if (data.phase === "verdict") {
      opsPush("debug", "Scrutiny verdict: " + String(data.action ?? data.name ?? "unknown"), data.score != null ? "score " + Number(data.score).toFixed(2) : "", "info");
    } else if (data.phase === "subagent") {
      opsPush("debug", "Delegation active", [data.n != null && data.total != null ? data.n + "/" + data.total : null, data.name ?? null].filter(Boolean).join(" · "), "think");
    } else if (data.phase === "awaiting-approval") {
      opsPush("debug", "Approval requested", data.name ?? data.toolName ?? "", "think");
    }
  } else if (type === "run-inspector") {
    opsPush("debug", "Run inspector: " + String(data.kind ?? data.phase ?? "event"), [data.status ?? null, data.name ?? null, data.runId ?? null].filter(Boolean).join(" · "), data.status === "failed" || data.ok === false ? "err" : "info");
  } else if (type === "pending-action" || type === "pending-action-decided") {
    opsPush("debug", type === "pending-action" ? "Pending action" : "Pending action decided", [data.toolName ?? null, data.summary ?? null, data.status ?? null].filter(Boolean).join(" · "), type === "pending-action" ? "think" : "info");
  } else if (type === "cron" || type === "mcp") {
    opsPush("system", type === "cron" ? "Cron event" : "MCP event", [data.op ?? null, data.id ?? null, data.name ?? null].filter(Boolean).join(" · "), "info");
  }
}


async function renderComputerUse() {
  // Computer-use beta — the agent's intent + reasoning log. Shows every
  // action the agent decided to take in a session, with the reasoning
  // it gave. Phase 1a: actions are stubbed (logged but not executed);
  // phase 1b will execute real input via the Mac app.
  const data = await fetchJson("/computer-use/log?limit=200").catch(() => ({ sessions: [], actions: [], stats: {} }));
  const { sessions = [], actions = [], stats = {}, enabled = false } = data;
  const active = sessions.find((s) => s.status === "active");

  const sessionCard = (s) => {
    const sActions = actions.filter((a) => a.sessionId === s.id);
    const isActive = s.status === "active";
    const statusBadge = isActive
      ? '<span class="ui-badge ui-badge-accent">active</span>'
      : s.status === "aborted"
        ? '<span class="ui-badge ui-badge-err">aborted</span>'
        : '<span class="ui-badge">' + escapeHtml(s.status) + '</span>';
    return \`
      <div class="ui-card" style="margin-bottom: var(--space-3);">
        <div class="ui-row" style="justify-content: space-between;">
          <div class="ui-grow">
            <div style="font-weight: 600;">\${escapeHtml(s.goal || "(no goal stated)")}</div>
            <div class="ui-meta">Started \${escapeHtml(new Date(s.startedAt).toLocaleString())} · approved by \${escapeHtml(s.approvedBy ?? "?")} · \${sActions.length} action\${sActions.length === 1 ? "" : "s"}</div>
            \${s.endedAt ? \`<div class="ui-meta">Ended \${escapeHtml(new Date(s.endedAt).toLocaleString())}\${s.endReason ? " · " + escapeHtml(s.endReason) : ""}</div>\` : ""}
          </div>
          <div>\${statusBadge}</div>
        </div>
        \${isActive ? \`<div style="margin-top: var(--space-2);"><button class="ui-btn ui-btn-destructive ui-btn-sm" data-abort="\${escapeHtml(s.id)}">⛔ Stop session</button></div>\` : ""}
        \${sActions.length > 0 ? \`
          <details \${isActive ? "open" : ""} style="margin-top: var(--space-2);">
            <summary class="ui-meta" style="cursor: pointer;">\${sActions.length} action\${sActions.length === 1 ? "" : "s"}</summary>
            <ol style="margin: var(--space-2) 0 0; padding-left: var(--space-4);">
              \${sActions.slice().reverse().map((a) => \`
                <li style="margin-bottom: var(--space-2);">
                  <div><strong>\${escapeHtml(a.kind)}</strong> \${escapeHtml(JSON.stringify(a.args)).slice(0, 140)}</div>
                  \${a.reasoning ? \`<div class="ui-meta">"\${escapeHtml(a.reasoning)}"</div>\` : '<div class="ui-meta" style="opacity:0.6;">(no reasoning given)</div>'}
                  <div class="ui-meta">\${escapeHtml(a.status)} · \${escapeHtml(new Date(a.createdAt).toLocaleTimeString())}</div>
                </li>
              \`).join("")}
            </ol>
          </details>
        \` : ""}
      </div>
    \`;
  };

  main.innerHTML = \`
    <div class="pane">
      <div class="ui-row" style="justify-content: space-between; align-items: flex-start; margin-bottom: var(--space-3);">
        <div>
          <h2 style="margin: 0;">Computer Use <span class="ui-badge">beta</span></h2>
          <div class="ui-meta" style="margin-top: 2px;">Phase 1a — actions are logged with reasoning but NOT executed yet (Mac CGEvent integration ships in phase 1b).</div>
        </div>
        <button
          id="computerUseToggle"
          class="ui-btn \${enabled ? "" : "ui-btn-ghost"} ui-btn-sm"
          data-enabled="\${enabled ? "1" : "0"}"
          title="Toggle computer-use tools on or off without restarting the daemon. Off-flips any active session and unregisters the tools so the agent stops seeing them."
        >\${enabled ? "✓ Enabled" : "Disabled"}</button>
      </div>

      <p class="ui-muted">Every action the agent intends to take is recorded here with its stated reasoning. Sessions are user-approved (via the standard approval gate). You can abort an active session at any time.</p>

      <div class="ui-row" style="gap: var(--space-2); margin: var(--space-3) 0;">
        <span class="ui-badge">\${stats.sessions ?? 0} sessions</span>
        <span class="ui-badge ui-badge-accent">\${stats.active ?? 0} active</span>
        <span class="ui-badge">\${stats.actions ?? 0} actions</span>
      </div>

      \${sessions.length === 0
        ? \`<div class="ui-empty">No sessions yet. When the agent decides to use the computer, it has to call <code>start_computer_use_session</code> with a goal — you approve, then it can act.</div>\`
        : sessions.map(sessionCard).join("")}
    </div>
  \`;

  document.querySelectorAll("[data-abort]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.abort;
      if (!confirm("Abort this computer-use session? The agent will be told to stop.")) return;
      try {
        await postJson(\`/computer-use/sessions/\${encodeURIComponent(id)}/abort\`, {});
        showToast("Session aborted.", true);
        await renderComputerUse();
      } catch (err) {
        showToast("Abort failed: " + err.message, false);
      }
    });
  });

  const toggleBtn = document.getElementById("computerUseToggle");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", async () => {
      const wasEnabled = toggleBtn.dataset.enabled === "1";
      const enable = !wasEnabled;
      // Enabling is one click; disabling needs a quick confirm because
      // it'll abort any active session.
      if (!enable && (stats.active ?? 0) > 0) {
        if (!confirm("Disable computer-use? This will abort " + stats.active + " active session(s).")) return;
      }
      toggleBtn.disabled = true;
      toggleBtn.textContent = enable ? "Enabling…" : "Disabling…";
      try {
        await postJson("/computer-use/toggle", { enable });
        showToast(enable ? "✓ Computer-use enabled. Tools registered." : "Computer-use disabled. Tools removed.", true);
        await renderComputerUse();
      } catch (err) {
        showToast("Toggle failed: " + err.message, false);
        toggleBtn.disabled = false;
        toggleBtn.textContent = wasEnabled ? "✓ Enabled" : "Disabled";
      }
    });
  }
}

async function renderActivity() {
  const stats = await fetchJson("/observations/stats").catch(() => ({}));
  state.activityFilter = state.activityFilter || { query: "" };
  main.innerHTML = \`
    <div class="pane">
      <h2>Activity <span class="muted" style="font-weight:400;font-size:14px;">· \${stats.mode === "sqlite" ? \`\${stats.activity ?? 0} events · \${stats.frames ?? 0} frames\` : \`mode: \${escapeHtml(stats.mode ?? "—")}\`}</span></h2>

      \${stats.mode !== "sqlite" && stats.mode !== "fallback-jsonl"
        ? '<div class="card warn-banner"><div class="name">Capture not running</div><div class="desc">Install the Mac app and grant Screen Recording + Accessibility permissions, or this view will be empty. Activity events appear as soon as the Mac app starts pushing.</div></div>'
        : ""}

      <div class="row" style="gap:10px;margin:14px 0;">
        <input type="search" id="actSearch" placeholder="Search OCR text or window titles…" value="\${escapeHtml(state.activityFilter.query)}" style="flex:1;">
        <select id="actSince" style="width:160px;">
          <option value="">All time</option>
          <option value="1h">Last hour</option>
          <option value="6h">Last 6 hours</option>
          <option value="24h" selected>Last 24 hours</option>
          <option value="7d">Last 7 days</option>
        </select>
      </div>

      <h3>Timeline (last 24h)</h3>
      <div id="timeline" class="card" style="padding:14px;"></div>

      <h3>Results</h3>
      <div id="actResults" class="grid"></div>
    </div>
  \`;
  const reload = async () => {
    const since = sinceFromOption($("actSince").value);
    const q = $("actSearch").value.trim();
    state.activityFilter.query = q;
    const results = await fetchJson("/observations/search?" + new URLSearchParams({
      ...(q ? { q } : {}),
      ...(since ? { since } : {}),
      limit: "60"
    }).toString());
    renderActivityResults(results);
  };
  const reloadTimeline = async () => {
    const tl = await fetchJson("/observations/timeline?since=" + encodeURIComponent(new Date(Date.now() - 24*3600*1000).toISOString()));
    renderTimeline(tl);
  };
  $("actSearch").addEventListener("input", debounce(reload, 250));
  $("actSince").addEventListener("change", reload);
  await Promise.all([reload(), reloadTimeline()]);
}

function sinceFromOption(value) {
  if (!value) return null;
  const m = { "1h": 1, "6h": 6, "24h": 24, "7d": 24 * 7 };
  const hours = m[value];
  if (!hours) return null;
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

function renderActivityResults(results) {
  const list = $("actResults");
  if (!list) return;
  if (!results || results.length === 0) {
    list.innerHTML = '<div class="empty">No matching activity yet.</div>';
    return;
  }
  list.innerHTML = results.map((r) => {
    const meta = [r.app, r.window].filter(Boolean).map(escapeHtml).join(" · ");
    const when = r.at ? new Date(r.at).toLocaleString() : "";
    const rawSnippet = r.snippet || r.text || r.window || r.event || "";
    // Stored observation text (BuildBetter transcripts, OCR of viewed pages)
    // is untrusted — escape it before innerHTML, but keep the FTS <mark>
    // highlight tags the search injects.
    const snippet = escapeHtml(rawSnippet).replaceAll("&lt;mark&gt;", "<mark>").replaceAll("&lt;/mark&gt;", "</mark>");
    return \`<div class="card">
      <div class="row between"><span class="name">\${escapeHtml(meta) || "(no app)"}</span><span class="muted" style="font-size:11px;">\${escapeHtml(when)}</span></div>
      <div class="desc" style="margin-top:6px;line-height:1.5;">\${snippet}</div>
    </div>\`;
  }).join("");
}

function renderTimeline(rows) {
  const host = $("timeline");
  if (!host) return;
  if (!rows || rows.length === 0) { host.innerHTML = '<div class="muted">No data in this window.</div>'; return; }
  // Group by hour, then show per-app stacked bars
  const byHour = new Map();
  const apps = new Set();
  for (const r of rows) {
    if (!byHour.has(r.hour)) byHour.set(r.hour, {});
    byHour.get(r.hour)[r.app || "—"] = r.n;
    apps.add(r.app || "—");
  }
  const sortedHours = [...byHour.keys()].sort();
  const max = Math.max(...rows.map((r) => r.n));
  const palette = ["#ff2b2b", "#ff5a4a", "#ff7a45", "#f0b454", "#ff9a7a", "#c9a09a"];
  const appColor = {};
  [...apps].forEach((a, i) => appColor[a] = palette[i % palette.length]);
  host.innerHTML = \`
    <div style="display:grid;grid-template-columns:repeat(\${sortedHours.length},1fr);gap:2px;align-items:end;height:80px;">
      \${sortedHours.map((h) => {
        const cell = byHour.get(h);
        const total = Object.values(cell).reduce((a, b) => a + b, 0);
        const stack = Object.entries(cell).map(([app, n]) =>
          \`<div style="height:\${(n / max) * 100}%;background:\${appColor[app]};" title="\${escapeHtml(app)}: \${n}"></div>\`
        ).join("");
        return \`<div title="\${escapeHtml(h)}: \${total}" style="display:flex;flex-direction:column-reverse;height:100%;">\${stack}</div>\`;
      }).join("")}
    </div>
    <div style="display:flex;justify-content:space-between;color:var(--muted);font-size:11px;margin-top:6px;">
      <span>\${escapeHtml(sortedHours[0] ?? "")}</span>
      <span>\${escapeHtml(sortedHours.at(-1) ?? "")}</span>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;">
      \${[...apps].map((a) => \`<span class="chip" style="border-color:\${appColor[a]};color:\${appColor[a]};">\${escapeHtml(a)}</span>\`).join("")}
    </div>
  \`;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function projectHeaders(headers = {}, projectScoped = true) {
  return {
    ...headers,
    ...(projectScoped ? { "x-openagi-project": state.projectId || "default" } : {})
  };
}

async function fetchJson(path, { projectScoped = true } = {}) {
  const r = await fetch(path, { headers: projectHeaders({}, projectScoped) });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error ?? \`\${path} -> \${r.status}\`);
  }
  return r.json();
}
async function postJson(path, body, { projectScoped = true } = {}) {
  const r = await fetch(path, {
    method: "POST",
    headers: projectHeaders({ "content-type": "application/json" }, projectScoped),
    body: JSON.stringify(body ?? {})
  });
  if (!r.ok) {
    const b = await r.json().catch(() => ({}));
    // Surface the structured error code (e.g. "budget") + status so callers
    // can tell "you hit your daily cap" apart from a network/agent failure.
    const err = new Error(b.code === "budget" ? (b.error ?? "Daily budget exceeded") + " — raise OPENAGI_DAILY_USD_LIMIT in setup." : (b.error ?? \`\${path} -> \${r.status}\`));
    err.code = b.code; err.status = r.status;
    throw err;
  }
  return r.json();
}
async function patchJson(path, body, { projectScoped = true } = {}) {
  const r = await fetch(path, {
    method: "PATCH",
    headers: projectHeaders({ "content-type": "application/json" }, projectScoped),
    body: JSON.stringify(body ?? {})
  });
  if (!r.ok) {
    const b = await r.json().catch(() => ({}));
    throw new Error(b.error ?? \`\${path} -> \${r.status}\`);
  }
  return r.json();
}
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]); }

// Inline help marker — renders a (?) chip with a hover tooltip. Use it for
// obscure terms in dense panes so users don't have to leave the page to
// understand what something means. Returns markup; caller composes it
// into the surrounding template literal.
// Example (with escaped dollar so the outer renderApp Node template
// doesn't try to interpolate it): Memory tier \\\${uiHelp("Short is RAM...")}
function uiHelp(text) {
  return \`<span class="ui-help" tabindex="0" aria-label="\${escapeHtml(text)}">?<span class="ui-help-tip">\${escapeHtml(text)}</span></span>\`;
}

async function renderRuns({ keepSelection = true } = {}) {
  const kindQuery = state.runKind
    ? "&kind=" + encodeURIComponent(state.runKind)
    : "";
  let payload;
  try {
    payload = await fetchJson("/runs?limit=200" + kindQuery);
  } catch (error) {
    main.innerHTML = '<div class="ui-empty">Run Inspector unavailable: '
      + escapeHtml(error.message) + '</div>';
    return;
  }
  state.runs = Array.isArray(payload.runs) ? payload.runs : [];
  const active = state.runs.filter((run) => (
    ["running", "waiting_approval", "editing", "verifying", "planned", "queued"]
      .includes(run.status)
  )).length;
  const passed = state.runs.filter((run) => (
    ["passed", "succeeded"].includes(run.status)
  )).length;
  const failed = state.runs.filter((run) => (
    ["failed", "blocked", "cancelled", "interrupted"].includes(run.status)
  )).length;
  const list = state.runs.length
    ? state.runs.map((run) => \`
        <button type="button" class="ui-card run-row \${state.runSelected?.id === run.id ? "active" : ""}"
          data-run-kind="\${escapeHtml(run.kind)}" data-run-id="\${escapeHtml(run.runId)}">
          <div class="ui-row">
            <span class="ui-badge">\${escapeHtml(run.kind)}</span>
            <span class="ui-badge \${runStatusClass(run.status)}">\${escapeHtml(run.status)}</span>
            <span class="ui-grow"></span>
            <span class="ui-meta">\${escapeHtml(timeAgo(run.updatedAt))}</span>
          </div>
          <div class="ui-meta" style="margin-top:6px;font-family:ui-monospace,Menlo,monospace;">\${escapeHtml(run.runId)}</div>
          \${renderRunMetrics(run.latest, { compact: true })}
        </button>
      \`).join("")
    : '<div class="ui-empty">No runs have been recorded for this project yet.</div>';
  main.innerHTML = \`
    <div class="ui-section">
      <div class="ui-section-header">
        <h2 style="margin:0;">Run Inspector</h2>
        <span class="ui-section-meta">Live operational facts and acceptance evidence. No secrets, tool arguments, or raw model reasoning.</span>
      </div>
      <div class="run-toolbar">
        <select id="runKindFilter" class="ui-select" style="width:auto;">
          <option value="" \${state.runKind === "" ? "selected" : ""}>All runs</option>
          <option value="turn" \${state.runKind === "turn" ? "selected" : ""}>Agent turns</option>
          <option value="coder" \${state.runKind === "coder" ? "selected" : ""}>Coder</option>
          <option value="qa" \${state.runKind === "qa" ? "selected" : ""}>Web QA</option>
          <option value="job" \${state.runKind === "job" ? "selected" : ""}>Jobs</option>
        </select>
        <span class="ui-badge">\${active} active</span>
        <span class="ui-badge ui-badge-accent">\${passed} passed</span>
        <span class="ui-badge \${failed ? "ui-badge-err" : ""}">\${failed} need attention</span>
        <button id="runRefresh" class="ui-btn ui-btn-secondary ui-btn-sm" type="button">Refresh</button>
      </div>
      <div class="run-layout">
        <div class="run-list" id="runList">\${list}</div>
        <div id="runDetail"><div class="ui-empty">Select a run to inspect its proof and timeline.</div></div>
      </div>
    </div>
  \`;
  document.getElementById("runKindFilter")?.addEventListener("change", (event) => {
    state.runKind = event.target.value;
    state.runSelected = null;
    renderRuns({ keepSelection: false });
  });
  document.getElementById("runRefresh")?.addEventListener("click", () => (
    renderRuns()
  ));
  document.querySelectorAll("[data-run-kind][data-run-id]").forEach((button) => {
    button.addEventListener("click", () => (
      showRunDetail(button.dataset.runKind, button.dataset.runId)
    ));
  });
  const retained = keepSelection && state.runSelected
    ? state.runs.find((run) => run.id === state.runSelected.id)
    : null;
  const selected = retained ?? state.runs[0] ?? null;
  if (selected) await showRunDetail(selected.kind, selected.runId);
}

async function showRunDetail(kind, runId) {
  const host = document.getElementById("runDetail");
  if (!host) return;
  host.innerHTML = '<div class="ui-empty">Loading run evidence…</div>';
  try {
    const payload = await fetchJson(
      "/runs/" + encodeURIComponent(kind) + "/" + encodeURIComponent(runId)
    );
    const run = payload.run;
    state.runSelected = { id: run.id, kind: run.kind, runId: run.runId };
    document.querySelectorAll(".run-row").forEach((row) => {
      row.classList.toggle(
        "active",
        row.dataset.runKind === run.kind && row.dataset.runId === run.runId
      );
    });
    host.innerHTML = \`
      <div class="ui-card">
        <div class="ui-row">
          <span class="ui-badge">\${escapeHtml(run.kind)}</span>
          <span class="ui-badge \${runStatusClass(run.status)}">\${escapeHtml(run.status)}</span>
          <span class="ui-grow"></span>
          <span class="ui-meta">updated \${escapeHtml(new Date(run.updatedAt).toLocaleString())}</span>
        </div>
        <h2 style="margin:10px 0 2px;font-family:ui-monospace,Menlo,monospace;font-size:16px;">\${escapeHtml(run.runId)}</h2>
        <div class="ui-meta">\${escapeHtml(run.sessionId ?? "no session")} · \${run.eventCount ?? 0} events</div>
      </div>
      \${renderRunMetrics(run.latest)}
      \${run.kind === "coder" && run.detail ? renderCoderRunDetail(run.detail) : ""}
      \${run.kind === "qa" && run.detail ? renderQaRunDetail(run, run.detail) : ""}
      \${run.kind === "job" && run.detail ? renderJobRunDetail(run.detail) : ""}
      \${renderRunTimeline(run.events)}
    \`;
  } catch (error) {
    host.innerHTML = '<div class="ui-empty">Could not load run: '
      + escapeHtml(error.message) + '</div>';
  }
}

function renderRunMetrics(metadata, { compact = false } = {}) {
  const entries = Object.entries(metadata ?? {}).filter(([, value]) => (
    value !== null && value !== undefined && !Array.isArray(value)
  ));
  if (!entries.length) return "";
  const shown = compact ? entries.slice(0, 3) : entries;
  return \`<div class="run-metrics" style="margin-top:\${compact ? "8px" : "12px"};">
    \${shown.map(([key, value]) => \`
      <div class="\${compact ? "ui-meta" : "ui-card"}">
        <div class="ui-meta">\${escapeHtml(humanRunKey(key))}</div>
        <div style="\${compact ? "" : "font-size:17px;font-weight:700;margin-top:3px;"}">\${escapeHtml(String(value))}</div>
      </div>
    \`).join("")}
  </div>\`;
}

function renderRunTimeline(events) {
  const rows = Array.isArray(events) ? events.slice().reverse() : [];
  if (!rows.length) return "";
  return \`
    <div class="ui-section">
      <div class="ui-section-header"><h3>Timeline</h3><span class="ui-section-meta">newest first</span></div>
      <div class="ui-card"><div class="run-timeline">
        \${rows.map((event) => \`
          <div class="run-event">
            <div class="ui-row">
              <strong>\${escapeHtml(humanRunKey(event.phase))}</strong>
              <span class="ui-badge \${runStatusClass(event.status)}">\${escapeHtml(event.status)}</span>
              <span class="ui-meta">#\${event.sequence} · \${escapeHtml(new Date(event.at).toLocaleTimeString())}</span>
            </div>
            \${renderRunMetrics(event.metadata, { compact: true })}
          </div>
        \`).join("")}
      </div></div>
    </div>
  \`;
}

function renderCoderRunDetail(detail) {
  const checks = detail.verification?.results ?? detail.checks ?? [];
  const criteria = detail.acceptance?.criteria ?? [];
  return \`
    <div class="ui-section">
      <div class="ui-section-header"><h3>Acceptance contract</h3>
        <span class="ui-badge \${runStatusClass(detail.acceptance?.status)}">\${escapeHtml(detail.acceptance?.status ?? "pending")}</span>
      </div>
      <div class="ui-stack">
        \${criteria.map((criterion) => \`
          <div class="ui-card">
            <div class="ui-row">
              <strong>\${escapeHtml(criterion.id)}</strong>
              <span class="ui-badge">\${escapeHtml(criterion.oracle)}</span>
              <span class="ui-badge">\${escapeHtml(criterion.kind)}</span>
            </div>
            <div style="margin-top:6px;">\${escapeHtml(criterion.statement)}</div>
            <div class="ui-meta" style="margin-top:5px;">checks: \${escapeHtml((criterion.checkIds ?? []).join(", "))}</div>
          </div>
        \`).join("") || '<div class="ui-empty">No acceptance criteria recorded.</div>'}
      </div>
    </div>
    <div class="ui-section">
      <div class="ui-section-header"><h3>Verification</h3></div>
      <div class="ui-stack">
        \${checks.map((check) => \`
          <div class="ui-card">
            <div class="ui-row">
              <strong>\${escapeHtml(check.id)}</strong>
              <span class="ui-badge">\${escapeHtml(check.type)}</span>
              \${typeof check.ok === "boolean" ? \`<span class="ui-badge \${check.ok ? "ui-badge-accent" : "ui-badge-err"}">\${check.ok ? "passed" : "failed"}</span>\` : ""}
              <span class="ui-grow"></span>
              \${check.durationMs != null ? \`<span class="ui-meta">\${check.durationMs} ms</span>\` : ""}
            </div>
            <div class="ui-meta" style="margin-top:5px;">\${escapeHtml(check.path ?? check.code ?? "")}</div>
          </div>
        \`).join("") || '<div class="ui-empty">Verification has not run yet.</div>'}
      </div>
    </div>
    \${detail.rollback ? \`
      <div class="ui-section">
        <div class="ui-section-header"><h3>Rollback</h3><span class="ui-badge \${runStatusClass(detail.rollback.status)}">\${escapeHtml(detail.rollback.status ?? "unknown")}</span></div>
        <div class="ui-card">\${escapeHtml((detail.rollback.files ?? []).map((file) => file.path + ": " + file.status).join(" · ") || "Rollback state recorded.")}</div>
      </div>
    \` : ""}
  \`;
}

function renderQaRunDetail(run, detail) {
  const artifactUrl = (ref) => (
    "/runs/qa/" + encodeURIComponent(run.runId)
      + "/artifacts/" + encodeURIComponent(ref)
      + "?project=" + encodeURIComponent(state.projectId || "default")
  );
  return \`
    <div class="ui-section">
      <div class="ui-section-header"><h3>QA evidence</h3>
        <span class="ui-section-meta">\${detail.summary?.passed ?? 0} passed · \${detail.summary?.failed ?? 0} failed</span>
      </div>
      <div class="qa-evidence-grid">
        \${(detail.results ?? []).map((result) => \`
          <div class="ui-card \${result.status === "failed" ? "qa-result-failed" : ""}">
            <div class="ui-row">
              <strong>\${escapeHtml(result.id)}</strong>
              <span class="ui-badge \${runStatusClass(result.status)}">\${escapeHtml(result.status)}</span>
              <span class="ui-badge">\${escapeHtml(result.viewport?.id ?? "")}</span>
            </div>
            <div class="ui-meta" style="margin-top:5px;">
              \${escapeHtml(result.routeId)}\${result.controlId ? " · " + escapeHtml(result.controlId) : ""}
            </div>
            \${result.screenshotRef ? \`<a href="\${artifactUrl(result.screenshotRef)}" target="_blank" rel="noopener"><img class="qa-shot" loading="lazy" alt="QA screenshot for \${escapeHtml(result.id)}" src="\${artifactUrl(result.screenshotRef)}"></a>\` : ""}
            \${result.visual?.diffRef ? \`<div class="ui-meta" style="margin-top:8px;">Visual diff · \${Math.round((result.visual.diffRatio ?? 0) * 100000) / 1000}% changed</div><a href="\${artifactUrl(result.visual.diffRef)}" target="_blank" rel="noopener"><img class="qa-shot" loading="lazy" alt="Visual diff for \${escapeHtml(result.id)}" src="\${artifactUrl(result.visual.diffRef)}"></a>\` : ""}
            \${(result.failures ?? []).map((failure) => \`<div class="err" style="margin-top:7px;"><strong>\${escapeHtml(failure.code)}</strong></div>\`).join("")}
            <div class="ui-row" style="margin-top:9px;">
              \${result.diagnosticsRef ? \`<a class="ui-btn ui-btn-secondary ui-btn-sm" href="\${artifactUrl(result.diagnosticsRef)}" target="_blank" rel="noopener">Diagnostics</a>\` : ""}
              \${result.traceRef ? \`<a class="ui-btn ui-btn-secondary ui-btn-sm" href="\${artifactUrl(result.traceRef)}">Trace</a>\` : ""}
              <span class="ui-meta">a11y \${result.accessibility?.violations ?? 0} · keyboard \${result.keyboard?.missing ?? 0}</span>
            </div>
          </div>
        \`).join("") || '<div class="ui-empty">No QA result evidence recorded.</div>'}
      </div>
    </div>
  \`;
}

function renderJobRunDetail(detail) {
  const timestamps = [
    ["started", detail.startedAt],
    ["finished", detail.finishedAt],
    ["recovered", detail.recoveredAt]
  ].filter(([, value]) => value);
  return \`
    <div class="ui-section">
      <div class="ui-section-header"><h3>Durable job</h3>
        <span class="ui-section-meta">attempt \${detail.attempt ?? 0} / \${detail.maxAttempts ?? 0}</span>
      </div>
      <div class="ui-card">
        <div class="ui-row">
          <strong>\${escapeHtml(detail.target ?? "unknown target")}</strong>
          <span class="ui-badge">\${escapeHtml(detail.kind ?? "job")}</span>
          \${detail.error?.code ? \`<span class="ui-badge ui-badge-err">\${escapeHtml(detail.error.code)}</span>\` : ""}
        </div>
        \${timestamps.length ? \`<div class="ui-meta" style="margin-top:7px;">\${timestamps.map(([label, value]) => label + ": " + new Date(value).toLocaleString()).join(" · ")}</div>\` : ""}
      </div>
    </div>
  \`;
}

function runStatusClass(status) {
  if (["passed", "succeeded"].includes(status)) return "ui-badge-accent";
  if (["failed", "blocked", "cancelled", "interrupted"].includes(status)) {
    return "ui-badge-err";
  }
  if (["waiting_approval", "verifying", "editing"].includes(status)) {
    return "ui-badge-warn";
  }
  return "";
}

function humanRunKey(value) {
  return String(value ?? "")
    .replaceAll("_", " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (letter) => letter.toUpperCase());
}

async function refreshHealth() {
  try {
    const [h, b, p] = await Promise.all([
      fetchJson("/health"),
      fetchJson("/budget").catch(() => null),
      fetchJson("/admin/provider").catch(() => null)
    ]);
    state.health = h;
    const provider = h.status.agentHost?.provider ?? "—";
    const model = h.status.agentHost?.providerModel ?? "";
    const configured = h.status.agentHost?.providerConfigured;
    const providerLabel = model ? \`\${provider} · \${model}\` : provider;
    const budgetLabel = b
      ? b.enabled === false
        ? \`$\${b.spentUsd.toFixed(2)} / uncapped\`
        : \`$\${b.spentUsd.toFixed(2)} / $\${b.dailyUsdLimit.toFixed(2)}\`
      : "";
    // Render as discrete nowrap pills so the header wraps cleanly between
    // pieces instead of breaking mid-pill (which produced the orphaned
    // "· $0.07 / $10.00" line in the old textContent layout).
    const pills = [
      \`<span class="status-pill">online</span>\`,
      \`<span class="status-pill">\${escapeHtml(providerLabel)} \${configured ? "✓" : "(no key)"}</span>\`,
      budgetLabel ? \`<span class="status-pill">\${escapeHtml(budgetLabel)}</span>\` : ""
    ].filter(Boolean);
    $("status").innerHTML = pills.join("");
    // Isolated: a throw inside the provider switch must not fall through to
    // the catch below and repaint a healthy daemon as "offline".
    if (p) { try { renderProviderSwitch(p); } catch (e) { console.error("providerSwitch:", e); } }
  } catch {
    $("status").innerHTML = '<span class="status-pill">offline</span>';
  }
}

async function refreshAmbientBadge() {
  let host = document.getElementById("ambientBadge");
  if (!host) {
    host = document.createElement("span");
    host.id = "ambientBadge";
    host.style.cssText = "margin-left:12px;font-size:12px;padding:3px 9px;border-radius:10px;border:1px solid var(--line);color:var(--muted);cursor:pointer;user-select:none;white-space:nowrap;";
    host.title = "Ambient context — what the agent sees from your screen. Click to view Activity tab.";
    host.addEventListener("click", () => switchTab("activity"));
    const slot = document.getElementById("status")?.parentElement
      || document.querySelector(".topbar");
    if (slot) slot.appendChild(host);
  }
  try {
    const ctx = await fetchJson("/observations/recent-context?minutes=10");
    const apps = ctx.apps?.length ?? 0;
    const snippets = ctx.snippets?.length ?? 0;
    if (apps === 0 && snippets === 0) {
      host.textContent = "👀 capture idle";
      host.style.color = "var(--muted)";
      host.style.borderColor = "var(--line)";
    } else {
      const topApp = ctx.apps?.[0]?.app?.split(".").pop() ?? "";
      host.textContent = \`👀 \${apps} app\${apps === 1 ? "" : "s"} · \${snippets} snippet\${snippets === 1 ? "" : "s"}\${topApp ? " · " + topApp : ""}\`;
      host.style.color = "var(--accent)";
      host.style.borderColor = "var(--accent)";
    }
  } catch {
    host.textContent = "👀 capture off";
    host.style.color = "var(--muted)";
    host.style.borderColor = "var(--line)";
  }
}

function renderProviderSwitch(p) {
  let host = document.getElementById("providerSwitch");
  if (!host) {
    host = document.createElement("span");
    host.id = "providerSwitch";
    host.style.marginLeft = "12px";
    host.style.fontSize = "12px";
    // Mount into .topbar — #status lives there, NOT inside any <header>.
    // The old "header .status" selector matched nothing (the only <header>
    // is header.sub in the sidebar), so this span was never attached and the
    // getElementById below threw, which refreshHealth()'s catch swallowed as
    // "offline" — pinning the pill to OFFLINE on a healthy daemon.
    const slot = document.getElementById("status")?.parentElement
      || document.querySelector(".topbar");
    if (slot) slot.appendChild(host);
  }
  const opts = [
    \`<option value="auto" \${p.preference === "auto" ? "selected" : ""}>auto</option>\`,
    \`<option value="anthropic" \${p.preference === "anthropic" ? "selected" : ""} \${!p.available?.anthropic ? "disabled" : ""}>Anthropic\${p.available?.anthropic ? "" : " (no key)"}</option>\`,
    \`<option value="openai" \${p.preference === "openai" ? "selected" : ""} \${!p.available?.openai ? "disabled" : ""}>OpenAI / ChatGPT\${p.available?.openai ? "" : " (no key)"}</option>\`,
    \`<option value="moa" \${p.preference === "moa" ? "selected" : ""} \${!p.available?.moa ? "disabled" : ""}>MoA\${p.moaPreset ? " / " + escapeHtml(p.moaPreset) : ""}\${p.available?.moa ? "" : " (no presets)"}</option>\`
  ].join("");
  host.innerHTML = \`<label style="color:var(--muted);">model: <select id="providerSelect" style="background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:2px 6px;font-size:12px;">\${opts}</select></label>\`;
  document.getElementById("providerSelect")?.addEventListener("change", async (e) => {
    try {
      await postJson("/admin/provider", { preference: e.target.value });
      refreshHealth();
    } catch (err) { alert("Switch failed: " + err.message); }
  });
}

const evt = new EventSource("/events?project=" + encodeURIComponent(state.projectId || "default"));
evt.addEventListener("message", (e) => {
  try {
    const data = JSON.parse(e.data);
    if (state.tab === "chat" && data.sessionId === state.sessionId && data.reply) {
      // already shown via direct response, skip
    } else {
      refreshSessions();
    }
  } catch {}
});
evt.addEventListener("cron", () => { if (state.tab === "cron") refreshCron(); });

// ── Live harness activity → pixel pet + holo avatar ──────────────────────
// Fires for turns driven by ANY channel (Discord, Telegram, cron, API), so
// the pet visibly thinks/works while Azazel is answering someone in Discord.
// Tool "start" = working, iteration/verdict = thinking, turn end = done.
var petActivityIdle = null;
function petActivityPoke(mode) {
  if (window.cerbPetReact) { try { window.cerbPetReact(mode); } catch (e) {} }
  if (window.cerbHoloReact) {
    try { window.cerbHoloReact(mode === "done" ? "idle" : "thinking"); } catch (e) {}
  }
  // Fall back to idle if the harness goes quiet (turn ended without a
  // terminal event, e.g. an aborted or errored turn upstream).
  if (petActivityIdle) clearTimeout(petActivityIdle);
  if (mode !== "done") {
    petActivityIdle = setTimeout(function () {
      if (window.cerbPetReact) { try { window.cerbPetReact("idle"); } catch (e) {} }
      if (window.cerbHoloReact) { try { window.cerbHoloReact("idle"); } catch (e) {} }
    }, 45000);
  }
}
evt.addEventListener("agent-activity", (e) => {
  try {
    const data = JSON.parse(e.data);
    const phase = data.phase;
    if (phase === "start") petActivityPoke("working");
    else if (phase === "iteration" || phase === "verdict" || phase === "subagent") petActivityPoke("thinking");
    else if (phase === "end") petActivityPoke(data.ok === false ? "error" : "working");
    else if (phase === "turn-end") petActivityPoke("done");
    else if (phase === "awaiting-approval") petActivityPoke("thinking");
  } catch (err) {}
});

evt.addEventListener("project", () => {
  if (state.tab === "projects") refreshProjects().catch(() => {});
});
evt.addEventListener("mcp", (e) => {
  if (state.tab === "mcp" && !composerOpen) refreshMcp();
  // Surface OAuth-required as a system notification if the page is unfocused
  try {
    const data = JSON.parse(e.data);
    if (data.op === "oauth-required" && document.hidden) {
      // Best-effort browser notification
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("Cerberus · OAuth required", { body: data.name + " — open the MCP tab to authorize." });
      }
    }
  } catch {}
});

// New skill candidate proposed by the pattern miner or session miner.
// Refresh the Skills tab if the user is on it; otherwise show a browser
// notification (the Mac app also fires its own native notification — see
// AppState SSE handler).
const handleSkillCandidateEvent = (e) => {
  if (state.tab === "skills") refreshSkills();
  if (state.tab === "suggestions") renderSuggestions("pending");
  try {
    const data = JSON.parse(e.data);
    if ("Notification" in window && Notification.permission === "granted") {
      const evidence = data.occurrences
        ? " - observed " + data.occurrences + " times"
          + (typeof data.confidence === "number"
            ? " at confidence " + data.confidence.toFixed(2)
            : "")
        : (data.description ? " - " + data.description : "");
      new Notification("Cerberus queued a skill candidate", {
        body: (data.title || data.name || "untitled") + evidence
      });
    }
  } catch {}
};
evt.addEventListener("skill-candidate", handleSkillCandidateEvent);
evt.addEventListener("skill-candidate-proposed", handleSkillCandidateEvent);

// Proactive suggestion — the observer noticed something it can help with.
// Show as a high-prominence toast (clickable to accept/reject) and fire a
// browser notification so the user sees it even if the dashboard isn't
// foregrounded. The Mac app's SSE delegate will also fire a native
// notification.
evt.addEventListener("proactive-suggestion", (e) => {
  try {
    const data = JSON.parse(e.data);
    const tag = data.category === "mcp" ? "✨ MCP" : data.category === "skill" ? "✨ Skill" : data.category === "automation" ? "✨ Auto" : "✨ FYI";
    const body = (data.title || "Suggestion") + (data.rationale ? " — " + data.rationale : "");
    showToast(tag + ": " + body, true);
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Cerberus noticed something", { body });
    }
  } catch {}
});

// Tasks updated — refresh tasks tab if visible, otherwise quiet.
evt.addEventListener("task-updated", () => {
  if (state.tab === "tasks") renderTasks();
});

evt.addEventListener("kanban-updated", () => {
  if (state.tab === "kanban") refreshKanban();
});

evt.addEventListener("kanban-status", (event) => {
  try {
    const data = JSON.parse(event.data);
    const transition = (data.fromStatus ? data.fromStatus + " -> " : "") + data.status;
    showToast("Kanban: " + (data.title || data.taskId) + " (" + transition + ")", data.status !== "blocked");
    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
      new Notification("Kanban status changed", {
        body: (data.title || data.taskId) + ": " + transition
      });
    }
  } catch {}
});

const refreshRunsLive = debounce(() => {
  if (state.tab === "runs") renderRuns().catch(() => {});
}, 150);
evt.addEventListener("run-inspector", refreshRunsLive);

// Auto-changed task (observation-driven completion or in-progress).
// Surface as a toast so the user sees what we did and can revert.
evt.addEventListener("task-auto-changed", (e) => {
  try {
    const data = JSON.parse(e.data);
    const verb = data.action === "complete" ? "Completed" : "Started";
    const icon = data.action === "complete" ? "✓" : "▶";
    const conf = data.confidence ? \` (\${Math.round(data.confidence * 100)}%)\` : "";
    // Show which evidence sources corroborated, so an auto-change is never a
    // black box — e.g. "via ocr+rize".
    const srcs = Array.isArray(data.sources) && data.sources.length ? \` · via \${data.sources.join("+")}\` : "";
    showToast(\`\${icon} Auto-\${verb.toLowerCase()}: \${data.title}\${conf}\${data.evidence ? " — " + data.evidence : ""}\${srcs}\`, true);
    if (state.tab === "tasks") renderTasks();
  } catch {}
});

// Morning plan ready — toast + browser notification; refresh Today if open.
evt.addEventListener("daily-plan", (e) => {
  try {
    const data = JSON.parse(e.data);
    showToast("🗓 " + (data.title || "Your day is planned") + (data.body ? " — " + data.body : ""), true);
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(data.title || "Your day", { body: data.body || "" });
    }
    if (state.tab === "today") renderToday();
  } catch {}
});

// A draft is ready for review — agent finished a draft-only task. Toast +
// refresh Today so the draft card appears immediately.
evt.addEventListener("draft-created", (e) => {
  try {
    const data = JSON.parse(e.data);
    showToast("📝 Draft ready to review: " + (data.title || "untitled"), true);
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Draft ready to review", { body: data.title || "" });
    }
    if (state.tab === "today") renderToday();
  } catch {}
});

// Clarification queued — the agent needs your call on a task. Toast +
// refresh the Today tab if it's open so the question appears immediately.
evt.addEventListener("clarification-created", (e) => {
  try {
    const data = JSON.parse(e.data);
    showToast("❓ " + (data.question || "Need your call on a task"), true);
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Needs your call", { body: data.question || "" });
    }
    if (state.tab === "today") renderToday();
  } catch {}
});

// Task notification (created, morning digest, or due-date) — toast + browser notif.
evt.addEventListener("task-reminder", (e) => {
  try {
    const data = JSON.parse(e.data);
    const icon = data.kind === "digest" || data.kind === "created" ? "📋 " : "⏰ ";
    showToast(icon + data.title + (data.body ? " — " + data.body : ""), true);
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(data.title, { body: data.body || "" });
    }
  } catch {}
});

// Cron catch-up: jobs that should've run during a sleep window are
// firing now. Surface a toast so the user knows the system noticed.
evt.addEventListener("cron-catchup", (e) => {
  try {
    const data = JSON.parse(e.data);
    const n = data.count ?? 0;
    const names = (data.jobs ?? []).slice(0, 3).map((j) => j.name).join(", ");
    const extra = (data.jobs?.length ?? 0) > 3 ? " (+" + (data.jobs.length - 3) + " more)" : "";
    const word = n === 1 ? "job" : "jobs";
    const tail = names ? ": " + names : "";
    showToast("✓ Caught up " + n + " missed cron " + word + tail + extra, true);
  } catch {}
});

setInterval(refreshHealth, 5000);
refreshHealth();
setInterval(refreshAmbientBadge, 15000);
refreshAmbientBadge();

// Honor ?tab=X in URL on first load — notifications + Mac tray menu deep-link
// to specific tabs and we need to land on them. Defaults to chat.
const VALID_TABS = new Set(["chat","tasks","memory","cron","kanban","projects","skills","mcp","integrations","agents","nodes","channels","budget","outcomes","scrutiny","health","activity","suggestions","computer-use","runs","today"]);
const initialTab = (() => {
  try {
    const t = new URLSearchParams(window.location.search).get("tab");
    return t && VALID_TABS.has(t) ? t : "chat";
  } catch { return "chat"; }
})();
switchTab(initialTab);

/* ─────────────────────────────────────────────────────────────
   CERBERUS ambient background — "phase transition" particle lattice
   Adapted from pbakaus/radiant "Phase Transition" (MIT), recolored to
   the crimson/black palette and tuned as a low-presence ambient layer.
   A grid of embers sweeps between ORDER (calm crimson lattice) and
   CHAOS (incandescent turbulence) behind a travelling wavefront.
   Canvas 2D, self-contained, honours prefers-reduced-motion and pauses
   when the tab is hidden. The wavefront gently follows the cursor.
   ───────────────────────────────────────────────────────────── */
(function cerbBackground() {
  var canvas = document.getElementById("cerbBg");
  if (!canvas) return;
  var ctx = canvas.getContext("2d");
  var prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Ambient tuning — keep it subtle behind the working UI. */
  var WAVE_SPEED = 0.35;
  var PARTICLE_DENSITY = 0.45;
  var AMBIENT = 0.55; /* global presence multiplier */

  var width, height, dpr, cx, cy;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx = width / 2;
    cy = height / 2;
  }
  var needsResize = false;
  window.addEventListener("resize", function() { needsResize = true; });
  resize();

  /* ── value noise + fbm ── */
  var perm = new Uint8Array(512);
  var grad2 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
  (function initNoise() {
    var p = new Uint8Array(256);
    for (var i = 0; i < 256; i++) p[i] = i;
    for (var i = 255; i > 0; i--) {
      var j = (Math.random() * (i + 1)) | 0;
      var t = p[i]; p[i] = p[j]; p[j] = t;
    }
    for (var i = 0; i < 512; i++) perm[i] = p[i & 255];
  })();
  function noise2d(x, y) {
    var ix = Math.floor(x) & 255, iy = Math.floor(y) & 255;
    var fx = x - Math.floor(x), fy = y - Math.floor(y);
    var ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    var g00 = grad2[perm[ix + perm[iy]] & 7];
    var g10 = grad2[perm[ix + 1 + perm[iy]] & 7];
    var g01 = grad2[perm[ix + perm[iy + 1]] & 7];
    var g11 = grad2[perm[ix + 1 + perm[iy + 1]] & 7];
    var d00 = g00[0] * fx + g00[1] * fy;
    var d10 = g10[0] * (fx - 1) + g10[1] * fy;
    var d01 = g01[0] * fx + g01[1] * (fy - 1);
    var d11 = g11[0] * (fx - 1) + g11[1] * (fy - 1);
    var nx0 = d00 + ux * (d10 - d00);
    var nx1 = d01 + ux * (d11 - d01);
    return nx0 + uy * (nx1 - nx0);
  }
  function fbm(x, y, oct) {
    var v = 0, a = 0.5, f = 1;
    for (var i = 0; i < oct; i++) { v += a * noise2d(x * f, y * f); a *= 0.5; f *= 2; }
    return v;
  }
  function smoothstep(e0, e1, x) {
    var t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  }

  /* ── particle lattice ── */
  var COUNT = 0, posX, posY, velX, velY, homeX, homeY, latticeCol, latticeRow;
  var cols, rows, spacingX, spacingY;
  function initParticles() {
    var area = width * height;
    var base = 2500 * PARTICLE_DENSITY;
    COUNT = Math.round(base * Math.sqrt(area / (1920 * 1080)));
    COUNT = Math.max(400, Math.min(COUNT, 5000));
    var aspect = width / height;
    rows = Math.round(Math.sqrt(COUNT / aspect));
    cols = Math.round(rows * aspect);
    COUNT = rows * cols;
    spacingX = width / (cols + 1);
    spacingY = height / (rows + 1);
    posX = new Float32Array(COUNT); posY = new Float32Array(COUNT);
    velX = new Float32Array(COUNT); velY = new Float32Array(COUNT);
    homeX = new Float32Array(COUNT); homeY = new Float32Array(COUNT);
    latticeCol = new Int32Array(COUNT); latticeRow = new Int32Array(COUNT);
    var idx = 0;
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var hx = (c + 1) * spacingX, hy = (r + 1) * spacingY;
        homeX[idx] = hx; homeY[idx] = hy;
        posX[idx] = hx + (Math.random() - 0.5) * spacingX * 0.3;
        posY[idx] = hy + (Math.random() - 0.5) * spacingY * 0.3;
        velX[idx] = 0; velY[idx] = 0;
        latticeCol[idx] = c; latticeRow[idx] = r;
        idx++;
      }
    }
  }
  initParticles();

  /* ── wavefront state ── */
  var wavePos = 0, waveDir = 1, wavePhase = 0, waveCycleTime = 0;

  /* ── trail buffer ── */
  var trailCanvas = document.createElement("canvas");
  var trailCtx = trailCanvas.getContext("2d");
  function resizeTrail() {
    trailCanvas.width = canvas.width;
    trailCanvas.height = canvas.height;
    trailCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    trailCtx.fillStyle = "#080404";
    trailCtx.fillRect(0, 0, width, height);
  }
  resizeTrail();

  /* ── glow sprites (crimson family) ── */
  var GLOW_RES = 64;
  function makeGlowSprite(r, g, b) {
    var c = document.createElement("canvas");
    c.width = GLOW_RES * 2; c.height = GLOW_RES * 2;
    var gc = c.getContext("2d");
    var grad = gc.createRadialGradient(GLOW_RES, GLOW_RES, 0, GLOW_RES, GLOW_RES, GLOW_RES);
    grad.addColorStop(0, "rgba(" + r + "," + g + "," + b + ", 0.6)");
    grad.addColorStop(0.3, "rgba(" + r + "," + g + "," + b + ", 0.2)");
    grad.addColorStop(0.7, "rgba(" + r + "," + g + "," + b + ", 0.04)");
    grad.addColorStop(1, "rgba(" + r + "," + g + "," + b + ", 0)");
    gc.fillStyle = grad;
    gc.beginPath();
    gc.arc(GLOW_RES, GLOW_RES, GLOW_RES, 0, Math.PI * 2);
    gc.fill();
    return c;
  }
  var glowOrdered = makeGlowSprite(0x8b, 0x1a, 0x16);
  var glowChaotic = makeGlowSprite(0xff, 0x3a, 0x26);
  var glowWave = makeGlowSprite(0xff, 0x5a, 0x42);

  /* ── crimson palette ──
     ORDER  : deep crimson  -> ember
     CHAOS  : hot signal red -> incandescent
     WAVE   : bright signal red                              */
  var ORD_R = 0x7a, ORD_G = 0x16, ORD_B = 0x16;
  var ORD_HI_R = 0xc2, ORD_HI_G = 0x3a, ORD_HI_B = 0x30;
  var CHA_R = 0xff, CHA_G = 0x2f, CHA_B = 0x1f;
  var CHA_HI_R = 0xff, CHA_HI_G = 0x9a, CHA_HI_B = 0x70;
  var WAVE_R = 0xff, WAVE_G = 0x4a, WAVE_B = 0x38;

  /* ── physics ── */
  var SPRING_K = 4.0, DAMPING = 3.5;
  var TURBULENCE_SCALE = 0.003, TURBULENCE_STRENGTH = 120;

  var paused = false, lastTime = 0;

  /* cursor nudges the wavefront; decays back to autonomous sweep */
  var mouseActive = false, mouseWavePos = 0.5, mouseIdleAt = 0;
  window.addEventListener("mousemove", function(e) {
    mouseActive = true;
    mouseWavePos = e.clientX / width;
    mouseIdleAt = performance.now();
  });

  function update(dt, time) {
    var cycleDuration = (width * 1.4) / (WAVE_SPEED * 180);
    waveCycleTime += dt;
    var raw = waveCycleTime / cycleDuration;
    var ci = Math.floor(raw);
    var wc = raw - ci;
    var eased = wc * wc * (3 - 2 * wc);
    if (ci % 2 === 0) { wavePos = eased; waveDir = 1; }
    else { wavePos = 1 - eased; waveDir = -1; }
    wavePhase = ci % 4 < 2 ? 0 : 1;

    if (mouseActive) {
      if (performance.now() - mouseIdleAt > 3000) mouseActive = false;
      else wavePos = mouseWavePos;
    }

    var wavePx = wavePos * width;
    var transWidth = width * 0.12;
    var noiseT = time * 0.4;

    for (var i = 0; i < COUNT; i++) {
      var px = posX[i], py = posY[i];
      var distToWave = (px - wavePx) * waveDir;
      var phase = wavePhase === 0
        ? 1 - smoothstep(-transWidth, transWidth, distToWave)
        : smoothstep(-transWidth, transWidth, distToWave);
      var transEnergy = 1 - Math.abs(distToWave) / transWidth;
      transEnergy = Math.max(0, transEnergy);
      transEnergy = transEnergy * transEnergy;

      var dx = homeX[i] - px, dy = homeY[i] - py;
      var orderedFx = dx * SPRING_K - velX[i] * DAMPING;
      var orderedFy = dy * SPRING_K - velY[i] * DAMPING;

      var nx = px * TURBULENCE_SCALE, ny = py * TURBULENCE_SCALE;
      var angle = fbm(nx + noiseT, ny + noiseT * 0.7, 3) * Math.PI * 4;
      var turbFx = Math.cos(angle) * TURBULENCE_STRENGTH;
      var turbFy = Math.sin(angle) * TURBULENCE_STRENGTH;
      var sa = Math.atan2(py - cy, px - cx);
      var sd = Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
      var ss = 30 * Math.min(1, sd / (width * 0.3));
      turbFx += Math.cos(sa + Math.PI * 0.5) * ss;
      turbFy += Math.sin(sa + Math.PI * 0.5) * ss;
      var chaoticFx = turbFx - velX[i] * 1.2;
      var chaoticFy = turbFy - velY[i] * 1.2;

      var kickFx = 0, kickFy = 0;
      if (transEnergy > 0.01) {
        var ka = fbm(nx * 2 + noiseT * 1.5, ny * 2 + 100, 2) * Math.PI * 2;
        var ks = transEnergy * 200;
        kickFx = Math.cos(ka) * ks; kickFy = Math.sin(ka) * ks;
      }

      var fx = orderedFx * (1 - phase) + chaoticFx * phase + kickFx;
      var fy = orderedFy * (1 - phase) + chaoticFy * phase + kickFy;
      velX[i] += fx * dt; velY[i] += fy * dt;
      var speed = Math.sqrt(velX[i] * velX[i] + velY[i] * velY[i]);
      if (speed > 300) { velX[i] = velX[i] / speed * 300; velY[i] = velY[i] / speed * 300; }
      posX[i] += velX[i] * dt; posY[i] += velY[i] * dt;

      var m = 20;
      if (posX[i] < -m) { posX[i] = -m; velX[i] = Math.abs(velX[i]) * 0.5; }
      if (posX[i] > width + m) { posX[i] = width + m; velX[i] = -Math.abs(velX[i]) * 0.5; }
      if (posY[i] < -m) { posY[i] = -m; velY[i] = Math.abs(velY[i]) * 0.5; }
      if (posY[i] > height + m) { posY[i] = height + m; velY[i] = -Math.abs(velY[i]) * 0.5; }
    }
  }

  function render(timestamp) {
    if (paused) { requestAnimationFrame(render); return; }
    if (needsResize) { needsResize = false; resize(); initParticles(); resizeTrail(); }
    if (!lastTime) lastTime = timestamp;
    var dt = Math.min((timestamp - lastTime) / 1000, 0.033);
    lastTime = timestamp;
    if (prefersReduced) dt *= 0.15;
    var time = timestamp / 1000;
    update(dt, time);

    /* fade previous frame into the trail buffer */
    trailCtx.fillStyle = "rgba(8, 4, 4, 0.15)";
    trailCtx.fillRect(0, 0, width, height);

    var wavePx = wavePos * width;
    var transWidth = width * 0.12;
    var noiseT = time * 0.4;

    /* Layer 1: chaotic-zone haze */
    if (!prefersReduced) {
      var bgStep = 40;
      for (var bx = 0; bx < width; bx += bgStep) {
        for (var by = 0; by < height; by += bgStep) {
          var dw = (bx - wavePx) * waveDir;
          var bp = wavePhase === 0
            ? 1 - smoothstep(-transWidth, transWidth, dw)
            : smoothstep(-transWidth, transWidth, dw);
          var nv = fbm(bx * 0.005 + noiseT * 0.3, by * 0.005 + noiseT * 0.2, 2);
          var ba = (0.01 + Math.abs(nv) * 0.04) * bp * AMBIENT;
          if (ba < 0.003) continue;
          trailCtx.fillStyle = "rgba(" + CHA_R + "," + CHA_G + "," + CHA_B + "," + ba.toFixed(3) + ")";
          trailCtx.fillRect(bx, by, bgStep, bgStep);
        }
      }
    }

    /* Layer 2: crimson lattice connections in ordered regions */
    trailCtx.lineWidth = 0.5;
    for (var i = 0; i < COUNT; i++) {
      var c = latticeCol[i], r = latticeRow[i];
      var dw2 = (posX[i] - wavePx) * waveDir;
      var ph = wavePhase === 0
        ? 1 - smoothstep(-transWidth, transWidth, dw2)
        : smoothstep(-transWidth, transWidth, dw2);
      if (ph > 0.5) continue;
      var orderedAmount = 1 - ph * 2;
      var lineAlpha = orderedAmount * 0.08 * AMBIENT;
      if (lineAlpha < 0.005) continue;
      if (c < cols - 1) {
        var j = i + 1;
        var ddx = posX[j] - posX[i], ddy = posY[j] - posY[i];
        var dist = Math.sqrt(ddx * ddx + ddy * ddy);
        if (dist < spacingX * 2) {
          var a = lineAlpha * (1 - dist / (spacingX * 2));
          trailCtx.strokeStyle = "rgba(140, 30, 26, " + a.toFixed(3) + ")";
          trailCtx.beginPath();
          trailCtx.moveTo(posX[i], posY[i]);
          trailCtx.lineTo(posX[j], posY[j]);
          trailCtx.stroke();
        }
      }
      if (r < rows - 1) {
        var j2 = i + cols;
        var ddx2 = posX[j2] - posX[i], ddy2 = posY[j2] - posY[i];
        var dist2 = Math.sqrt(ddx2 * ddx2 + ddy2 * ddy2);
        if (dist2 < spacingY * 2) {
          var a2 = lineAlpha * (1 - dist2 / (spacingY * 2));
          trailCtx.strokeStyle = "rgba(140, 30, 26, " + a2.toFixed(3) + ")";
          trailCtx.beginPath();
          trailCtx.moveTo(posX[i], posY[i]);
          trailCtx.lineTo(posX[j2], posY[j2]);
          trailCtx.stroke();
        }
      }
    }

    /* Layer 3: wavefront band */
    if (!prefersReduced) {
      var wg = transWidth * 2.5;
      var grad = trailCtx.createLinearGradient(wavePx - wg, 0, wavePx + wg, 0);
      grad.addColorStop(0, "rgba(255, 74, 56, 0)");
      grad.addColorStop(0.3, "rgba(255, 74, 56, " + (0.02 * AMBIENT).toFixed(3) + ")");
      grad.addColorStop(0.5, "rgba(255, 110, 90, " + (0.06 * AMBIENT).toFixed(3) + ")");
      grad.addColorStop(0.7, "rgba(255, 74, 56, " + (0.02 * AMBIENT).toFixed(3) + ")");
      grad.addColorStop(1, "rgba(255, 74, 56, 0)");
      trailCtx.fillStyle = grad;
      trailCtx.fillRect(wavePx - wg, 0, wg * 2, height);
      trailCtx.strokeStyle = "rgba(255, 120, 96, " + (0.12 * AMBIENT).toFixed(3) + ")";
      trailCtx.lineWidth = 2;
      trailCtx.beginPath();
      for (var y = 0; y < height; y += 8) {
        var wob = fbm(y * 0.01 + time * 0.5, time * 0.3, 2) * 15;
        if (y === 0) trailCtx.moveTo(wavePx + wob, y);
        else trailCtx.lineTo(wavePx + wob, y);
      }
      trailCtx.stroke();
    }

    /* Layer 4: chaotic trails */
    for (var i2 = 0; i2 < COUNT; i2++) {
      var dw3 = (posX[i2] - wavePx) * waveDir;
      var ph3 = wavePhase === 0
        ? 1 - smoothstep(-transWidth, transWidth, dw3)
        : smoothstep(-transWidth, transWidth, dw3);
      if (ph3 > 0.3) {
        var spd = Math.sqrt(velX[i2] * velX[i2] + velY[i2] * velY[i2]);
        var ta = ph3 * Math.min(1, spd / 100) * 0.15 * AMBIENT;
        if (ta > 0.005) {
          trailCtx.fillStyle = "rgba(" + CHA_R + "," + CHA_G + "," + CHA_B + "," + ta.toFixed(3) + ")";
          trailCtx.beginPath();
          trailCtx.arc(posX[i2], posY[i2], 1.5, 0, Math.PI * 2);
          trailCtx.fill();
        }
      }
    }

    /* composite trail onto main canvas */
    ctx.drawImage(trailCanvas, 0, 0, trailCanvas.width, trailCanvas.height, 0, 0, width, height);

    /* Layer 5: particle cores */
    for (var i3 = 0; i3 < COUNT; i3++) {
      var ppx = posX[i3], ppy = posY[i3];
      var dw4 = (ppx - wavePx) * waveDir;
      var ph4 = wavePhase === 0
        ? 1 - smoothstep(-transWidth, transWidth, dw4)
        : smoothstep(-transWidth, transWidth, dw4);
      var te = 1 - Math.abs(dw4) / transWidth;
      te = Math.max(0, te); te = te * te;
      var baseSize = 1.2 + ph4 * 0.8;
      var size = baseSize + te * 2.5;
      var spd2 = Math.sqrt(velX[i3] * velX[i3] + velY[i3] * velY[i3]);
      var eb = Math.min(1, spd2 / 150);
      var rr, gg, bb;
      if (te > 0.1) {
        var tt = te;
        rr = WAVE_R + (255 - WAVE_R) * tt * 0.5;
        gg = WAVE_G + (255 - WAVE_G) * tt * 0.5;
        bb = WAVE_B + (255 - WAVE_B) * tt * 0.3;
      } else if (ph4 < 0.5) {
        var ddx3 = ppx - homeX[i3], ddy3 = ppy - homeY[i3];
        var dfh = Math.sqrt(ddx3 * ddx3 + ddy3 * ddy3);
        var settled = 1 - Math.min(1, dfh / spacingX);
        rr = ORD_R + (ORD_HI_R - ORD_R) * settled;
        gg = ORD_G + (ORD_HI_G - ORD_G) * settled;
        bb = ORD_B + (ORD_HI_B - ORD_B) * settled;
      } else {
        rr = CHA_R + (CHA_HI_R - CHA_R) * eb;
        gg = CHA_G + (CHA_HI_G - CHA_G) * eb;
        bb = CHA_B + (CHA_HI_B - CHA_B) * eb;
      }
      var alpha = (0.6 + te * 0.4 + eb * 0.15) * AMBIENT;
      alpha = Math.min(1, alpha);
      if (te > 0.05 || (ph4 > 0.5 && spd2 > 50)) {
        var gs = size * 3;
        var ga = (te * 0.3 + eb * 0.08) * alpha;
        if (ga > 0.005) {
          var sprite = te > 0.1 ? glowWave : (ph4 < 0.5 ? glowOrdered : glowChaotic);
          ctx.globalAlpha = Math.min(ga, 0.8);
          ctx.drawImage(sprite, ppx - gs, ppy - gs, gs * 2, gs * 2);
          ctx.globalAlpha = 1;
        }
      }
      ctx.fillStyle = "rgba(" + Math.round(rr) + "," + Math.round(gg) + "," + Math.round(bb) + "," + alpha.toFixed(3) + ")";
      ctx.beginPath();
      ctx.arc(ppx, ppy, size, 0, Math.PI * 2);
      ctx.fill();
      if (te > 0.3) {
        ctx.fillStyle = "rgba(255, 235, 225, " + (te * 0.5 * AMBIENT).toFixed(3) + ")";
        ctx.beginPath();
        ctx.arc(ppx, ppy, size * 0.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    /* vignette */
    var maxDim = Math.max(width, height);
    var vig = ctx.createRadialGradient(cx, cy, maxDim * 0.3, cx, cy, maxDim * 0.85);
    vig.addColorStop(0, "rgba(5, 2, 2, 0)");
    vig.addColorStop(1, "rgba(5, 2, 2, 0.4)");
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, width, height);

    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  document.addEventListener("visibilitychange", function() {
    paused = document.hidden;
    if (!paused) lastTime = 0;
  });
})();

/* ─── Cerberus pixel pet — reactive dashboard companion (v4: 4-tier evolution) ──
   A 16-bit three-headed hellhound that lives on the dashboard, follows the
   mouse, and reacts to what the harness is doing. Parts-based pixel rig
   rendered on a low-res canvas and nearest-neighbour upscaled. States mirror
   the petdex contract: idle / running / review / failed / waving / jumping /
   waiting. cerbPetReact(mode) is the single reactivity entry point (same
   pattern as cerbHoloReact). Honours prefers-reduced-motion.

   Views: a FRONT-facing pose when stationary (three heads fanned, tail
   wagging) and a SIDE pose when walking/running. Animation is sampled at
   15 fps. Easter-egg idles fire roughly every 5 minutes while idle.

   EVOLUTION LADDER — four forms, each a step up in size, palette depth and
   detail, each with its own idle / thinking / working animations and its own
   set of easter-egg idles:

     0 PUP            64x52   16-bit, 3 eggs (play / fire / howl)
     1 PRIME CERBERUS 80x64   24-bit, chest rune + gold pauldrons + horns
     2 ULTRA CERBERUS 96x76   lava-cracked obsidian, gold crown crest,
                              starburst chest gem, spiked bracers, dual tails
                              (spade + barbed), 4 gold talons, 5 eggs
     3 OMEGA CERBERUS 112x88  polished obsidian + gold inlay, V-chevron chest
                              + 2 diamond studs, 4-barb tail, CRT scanline
                              aura, 5 eggs — the apex form

   XP accrues from harness activity (thinking / working / done) and from the
   specific tool-call type the harness reports. Thresholds: PUP->PRIME 100,
   PRIME->ULTRA 300, ULTRA->OMEGA 700. A settings panel (gear button) toggles
   the pet on/off, customises size/glow/auto-evolve, and lets you switch form
   manually. Stage + XP persist across reloads via localStorage. */
(function () {
  "use strict";
  if (window.__cerbPetLoaded) return;
  window.__cerbPetLoaded = true;

  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ── geometry per form ── */
  var FORMS = [
    { key:"pup",   name:"PUP",            w:64,  h:52, xpMax:100, flame:1.00, pal:0, res:1 },
    { key:"prime", name:"PRIME CERBERUS", w:80,  h:64, xpMax:300, flame:1.18, pal:1, res:1 },
    { key:"ultra", name:"ULTRA CERBERUS", w:96,  h:76, xpMax:700, flame:1.40, pal:2, res:1 },
    { key:"omega", name:"OMEGA CERBERUS", w:160, h:160, xpMax:1500, flame:1.65, pal:3, res:3 },
    { key:"alpha", name:"ALPHA CERBERUS", w:160, h:160, xpMax:0,  flame:1.95, pal:4, res:3 }
  ];
  var FPS = 15, FRAME_MS = 1000 / FPS;
  var TICKS_PER_FRAME = Math.round(60 / FPS);
  /* Buffer size is per-form (w*res × h*res) and the display canvas tracks the
     active form, so there is no single global MAX — each form carries its own
     resolution via FORMS[i].res. */

  /* ── palettes ── */
  var PAL = {   /* PUP — 16-bit */
    outline:"#12101a", furDeep:"#14141c", furDark:"#222838", furMid:"#2e3a4a",
    furLight:"#46586b", rim:"#d9a441", rimHot:"#f0c060",
    flameCore:"#fff4d0", flameYel:"#ffd24a", flameOrg:"#ff8a1e", flameRed:"#e0451a",
    eye:"#ff9a1e", eyeCore:"#fff0b0", fang:"#f0e8d0", claw:"#c9c0aa",
    mouth:"#5a1620", tongue:"#c24a62", nose:"#0e0c14", earIn:"#7a3222"
  };
  var PAL2 = {  /* PRIME — 24-bit */
    outline:"#16101c", furDeep:"#12121c", furDark:"#1c2230", furMid:"#283244",
    furLight:"#3a4a60", furHi:"#54687f", rim:"#e8b84a", rimHot:"#ffd97a",
    armor:"#8a6420", armorHi:"#d4a844", armorDk:"#5a4214",
    rune:"#ff3a2a", runeCore:"#ffb08a",
    flameCore:"#fffbe8", flameYel:"#ffd94a", flameOrg:"#ff9a2a", flameRed:"#f04a1e", flameMag:"#c02a5a",
    eye:"#ffb02a", eyeCore:"#fff4c8", fang:"#f4ecd8", claw:"#d8cfb8",
    mouth:"#6a1824", tongue:"#d05a72", nose:"#0e0c16", earIn:"#8a3a28",
    horn:"#e8dcc0", hornDk:"#a89878"
  };
  var PAL3 = {  /* ULTRA — lava-cracked obsidian + gold regalia */
    outline:"#0c0c12", furDeep:"#141418", furDark:"#232329", furMid:"#3a3a42",
    furLight:"#4c4c55", furHi:"#5c5c66", rim:"#7a3410", rimHot:"#ff7a2a",
    lava1:"#7a1400", lava2:"#c83000", lava3:"#ff5a14", lava4:"#ffd24a", lava5:"#ffe680",
    gold:"#e8b038", goldHi:"#ffe080", goldDk:"#a86c18",
    gem:"#ff3a1a", gemCore:"#ffe080", gemHalo:"#c01800",
    flameCore:"#fff0b0", flameYel:"#ffd84a", flameOrg:"#ff7a1a", flameRed:"#ff5a00", flameDeep:"#5a0d00",
    eye:"#ff5a1e", eyeCore:"#ffe680", fang:"#f4ecd8", claw:"#e0982a", clawHi:"#ffd24a",
    mouth:"#5a1210", tongue:"#c24a3a", nose:"#0a0a10", earIn:"#7a2010"
  };
  var PAL4 = {  /* OMEGA — molten obsidian + gold inlay (ember veins beneath the hide) */
    /* fur ramp is WARM near-black charcoal (red>b>g), never cool blue-gray —
       the blue cast read as mech armor. Plate separation comes from heat, not value. */
    outline:"#0a0806", furDeep:"#100c0a", furDark:"#171210", furMid:"#221a15",
    furLight:"#3a2a1e", furHi:"#5a3a22", rim:"#e8641e", rimHot:"#ffb04a",
    gold:"#d99a3a", goldHi:"#ffd878", goldDk:"#8a5a1e",
    gem:"#e0461a", gemCore:"#ffd24a", gemHalo:"#7a1400",
    lava1:"#7a1400", lava2:"#c83000", lava3:"#ff5a14", lava4:"#ffd24a", lava5:"#ffe680",
    flameCore:"#fff0b0", flameYel:"#ffd84a", flameOrg:"#ff7a1a", flameRed:"#e0451a", flameDeep:"#5a0d00",
    eye:"#ff5a1e", eyeCore:"#fff0a0", fang:"#f4ecd8", claw:"#d99a3a", clawHi:"#ffd878",
    mouth:"#3a1018", tongue:"#a83a4a", nose:"#0a0c10", earIn:"#1b1f24",
    aura:"#ff5a1e"
  };
  var PAL5 = {  /* ALPHA — ascended: white-gold plasma, the ember veins burned through to daylight */
    /* the hide has gone from cooling charcoal to sun-bleached bone-ash: the
       heat is no longer *under* the skin, it IS the skin. Cyan-white core
       against gold, so ALPHA reads instantly different from OMEGA's red. */
    outline:"#1a0f04", furDeep:"#241608", furDark:"#3a2410", furMid:"#5c3c1a",
    furLight:"#8f6428", furHi:"#c99a48", rim:"#ffd878", rimHot:"#fffbe8",
    gold:"#ffca55", goldHi:"#fffbe8", goldDk:"#b07a24",
    gem:"#7fe8ff", gemCore:"#ffffff", gemHalo:"#1a6a8a",
    lava1:"#8a4a00", lava2:"#ff9a1e", lava3:"#ffd24a", lava4:"#fff0b0", lava5:"#ffffff",
    flameCore:"#ffffff", flameYel:"#fff4c0", flameOrg:"#ffc24a", flameRed:"#ff8a1e", flameDeep:"#a34a00",
    eye:"#9ff0ff", eyeCore:"#ffffff", fang:"#ffffff", claw:"#ffd878", clawHi:"#ffffff",
    mouth:"#5a2410", tongue:"#e08a6a", nose:"#1a1408", earIn:"#3a2a18",
    aura:"#ffd878"
  };
  var PALS = [PAL, PAL2, PAL3, PAL4, PAL5];

  /* ── off-screen buffers, one per form ── */
  var bufs = [];
  for (var bi=0; bi<FORMS.length; bi++) {
    var c = document.createElement("canvas");
    c.width = FORMS[bi].w * (FORMS[bi].res||1); c.height = FORMS[bi].h * (FORMS[bi].res||1);
    bufs.push({ canvas:c, ctx:c.getContext("2d", { willReadFrequently:true }) });
  }

  /* ── pixel primitives ── */
  function pxEllipse(ctx, cx, cy, rx, ry, color) {
    ctx.fillStyle = color;
    for (var y = -ry; y <= ry; y++) {
      var w = Math.floor(rx * Math.sqrt(Math.max(0, 1 - (y*y)/(ry*ry+0.001))));
      ctx.fillRect(Math.round(cx-w), Math.round(cy+y), w*2+1, 1);
    }
  }
  function pxRect(ctx, x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }
  function pxLine(ctx, x0, y0, x1, y1, thick, color) {
    ctx.fillStyle = color;
    var steps = Math.max(Math.abs(x1-x0), Math.abs(y1-y0)) * 2 + 1;
    var r = Math.floor(thick/2);
    for (var i = 0; i <= steps; i++) {
      var t = i/steps;
      ctx.fillRect(Math.round(x0+(x1-x0)*t)-r, Math.round(y0+(y1-y0)*t)-r, thick, thick);
    }
  }
  function pxTri(ctx, x0,y0, x1,y1, x2,y2, color) {
    ctx.fillStyle = color;
    var minx=Math.floor(Math.min(x0,x1,x2)), maxx=Math.ceil(Math.max(x0,x1,x2));
    var miny=Math.floor(Math.min(y0,y1,y2)), maxy=Math.ceil(Math.max(y0,y1,y2));
    function sign(a,b,c,d,e,f){return (c-a)*(f-b)-(d-b)*(e-a);}
    for (var y=miny;y<=maxy;y++) for (var x=minx;x<=maxx;x++) {
      var d1=sign(x,y,x0,y0,x1,y1), d2=sign(x,y,x1,y1,x2,y2), d3=sign(x,y,x2,y2,x0,y0);
      var neg=(d1<0)||(d2<0)||(d3<0), pos=(d1>0)||(d2>0)||(d3>0);
      if (!(neg&&pos)) ctx.fillRect(x,y,1,1);
    }
  }
  /* diamond / rhombus (vertical lozenge) */
  function pxDiamond(ctx, cx, cy, rw, rh, color) {
    ctx.fillStyle = color;
    for (var y = -rh; y <= rh; y++) {
      var w = Math.round(rw * (1 - Math.abs(y)/rh));
      ctx.fillRect(Math.round(cx-w), Math.round(cy+y), w*2+1, 1);
    }
  }

  function flameTongue(ctx, bx, by, h, w, sway, seed, pal) {
    pal = pal || PAL;
    for (var i = 0; i < h; i++) {
      var t = i/h;
      var y = Math.round(by - i);
      var x = Math.round(bx + sway * t * t);
      var half = Math.max(0, Math.round((w/2) * (1 - t*0.7)));
      if (t > 0.75 && ((i + seed) % 3 === 0)) half = Math.max(0, half-1);
      var color;
      if (t < 0.18) color = pal.flameCore;
      else if (t < 0.42) color = pal.flameYel;
      else if (t < 0.72) color = pal.flameOrg;
      else color = pal.flameRed;
      ctx.fillStyle = color;
      ctx.fillRect(x-half, y, half*2+1, 1);
    }
  }
  /* hotter 5-band flame for ULTRA/OMEGA (adds a deep-red base band) */
  function flameTongue5(ctx, bx, by, h, w, sway, seed, pal) {
    pal = pal || PAL;
    for (var i = 0; i < h; i++) {
      var t = i/h;
      var y = Math.round(by - i);
      var x = Math.round(bx + sway * t * t);
      var half = Math.max(0, Math.round((w/2) * (1 - t*0.72)));
      if (t > 0.8 && ((i + seed) % 3 === 0)) half = Math.max(0, half-1);
      var color;
      if (t < 0.14) color = pal.flameCore;
      else if (t < 0.34) color = pal.flameYel;
      else if (t < 0.58) color = pal.flameOrg;
      else if (t < 0.82) color = pal.flameRed;
      else color = pal.flameDeep;
      ctx.fillStyle = color;
      ctx.fillRect(x-half, y, half*2+1, 1);
    }
  }
  /* sinuous flame tongue — per-column phase-offset horizontal sine displacement
     so adjacent tongues lean opposite ways instead of marching in lockstep;
     width tapers full-at-base to 1px-at-tip (a constant-width tongue is a bar).
     A secondary sine wave creates an S-curve so the tongue whips, not just leans.
     amp = lateral sway amplitude, phase = per-column offset, time = flick*speed. */
  function flameTongueSin(ctx, bx, by, h, w, amp, phase, time, seed, pal) {
    pal = pal || PAL;
    /* amplitude scales with height so the tallest tongues whip the most */
    var a = amp * (0.6 + 0.4 * (h / 80));
    for (var i = 0; i < h; i++) {
      var t = i/h;
      var y = Math.round(by - i);
      /* primary wave + secondary wave (S-curve); amplitude grows toward the tip
         so the base stays planted while the top whips. */
      var dx = a * (Math.sin(t*3.2 + phase + time) + 0.45*Math.sin(t*7.1 + phase*1.3 + time*1.7)) * (0.2 + 0.8*t);
      var x = Math.round(bx + dx);
      var half = Math.max(0, Math.round((w/2) * (1 - t*0.92)));
      if (t > 0.82 && ((i + seed) % 3 === 0)) half = Math.max(0, half-1);
      var color;
      if (t < 0.14) color = pal.flameCore;
      else if (t < 0.34) color = pal.flameYel;
      else if (t < 0.58) color = pal.flameOrg;
      else if (t < 0.82) color = pal.flameRed;
      else color = pal.flameDeep;
      ctx.fillStyle = color;
      ctx.fillRect(x-half, y, half*2+1, 1);
    }
  }

  /* ── generic head (PUP / PRIME share this with palette + size) ── */
  function drawHead(ctx, cx, cy, o, pal) {
    pal = pal || PAL;
    var dir = o.dir||0, s = o.size||1, roar = o.roar||false, blink = o.blink||0;
    var gx = o.gazeX||0, gy = o.gazeY||0;
    var hw = Math.round(6*s), hh = Math.round(5*s);
    var snoutX = dir * Math.round(3*s);
    pxEllipse(ctx, cx, cy, hw+1, hh+1, pal.outline);
    var earH = Math.round(4*s);
    pxTri(ctx, cx-hw+1, cy-hh+2, cx-hw-2, cy-hh-earH, cx-hw+4, cy-hh, pal.furDark);
    pxTri(ctx, cx+hw-1, cy-hh+2, cx+hw+2, cy-hh-earH, cx+hw-4, cy-hh, pal.furDark);
    pxRect(ctx, cx-hw, cy-hh-1, 1, 2, pal.earIn);
    pxRect(ctx, cx+hw-1, cy-hh-1, 1, 2, pal.earIn);
    pxEllipse(ctx, cx, cy, hw, hh, pal.furMid);
    pxEllipse(ctx, cx-1, cy-hh+2, hw-3, 2, pal.furLight);
    pxEllipse(ctx, cx+snoutX, cy+2, 3, 2, pal.furLight);
    pxRect(ctx, cx+snoutX + dir*2 - 1, cy+1, 2, 2, pal.nose);
    var ey = cy-2;
    var exL = cx-4 + (dir<0?1:0), exR = cx+2 + (dir>0?-1:0);
    if (blink > 0.9) {
      pxRect(ctx, exL, ey+1, 2, 1, pal.outline);
      pxRect(ctx, exR, ey+1, 2, 1, pal.outline);
    } else {
      pxRect(ctx, exL+gx, ey+gy, 2, 2, pal.eye);
      pxRect(ctx, exL+gx, ey+gy, 1, 1, pal.eyeCore);
      pxRect(ctx, exR+gx, ey+gy, 2, 2, pal.eye);
      pxRect(ctx, exR+1+gx, ey+gy, 1, 1, pal.eyeCore);
    }
    var mx = cx + snoutX;
    if (roar) {
      var mw = Math.round(6*s), mh = Math.round(4*s), my = cy+2;
      pxEllipse(ctx, mx, my+mh/2, mw/2, mh/2, pal.mouth);
      pxEllipse(ctx, mx, my+mh/2+1, Math.max(1,mw/2-2), Math.max(1,mh/2-1), pal.tongue);
      pxTri(ctx, mx-mw/2+1, my, mx-mw/2+2, my+3, mx-mw/2+3, my, pal.fang);
      pxTri(ctx, mx+mw/2-3, my, mx+mw/2-2, my+3, mx+mw/2-1, my, pal.fang);
      pxRect(ctx, mx-mw/2+2, my+mh-1, mw-4, 1, pal.fang);
    } else {
      pxRect(ctx, mx-3, cy+3, 6, 1, pal.outline);
      pxTri(ctx, mx+dir*2-1, cy+3, mx+dir*2, cy+5, mx+dir*2+1, cy+3, pal.fang);
    }
  }

  /* prime head — larger, horns on center head, richer shading */
  function drawHead2(ctx, cx, cy, o) {
    var pal = PAL2;
    var dir = o.dir||0, s = o.size||1, roar = o.roar||false, blink = o.blink||0;
    var gx = o.gazeX||0, gy = o.gazeY||0;
    var horn = o.horn||false;
    var hw = Math.round(7*s), hh = Math.round(6*s);
    var snoutX = dir * Math.round(4*s);
    pxEllipse(ctx, cx, cy, hw+1, hh+1, pal.outline);
    var earH = Math.round(5*s);
    pxTri(ctx, cx-hw+1, cy-hh+2, cx-hw-2, cy-hh-earH, cx-hw+4, cy-hh, pal.furDark);
    pxTri(ctx, cx+hw-1, cy-hh+2, cx+hw+2, cy-hh-earH, cx+hw-4, cy-hh, pal.furDark);
    pxRect(ctx, cx-hw, cy-hh-1, 1, 2, pal.earIn);
    pxRect(ctx, cx+hw-1, cy-hh-1, 1, 2, pal.earIn);
    if (horn) {
      var hornH = Math.round(7*s), hornW = Math.round(3*s);
      pxTri(ctx, cx-hornW, cy-hh+1, cx-hornW-2, cy-hh-hornH, cx-1, cy-hh, pal.horn);
      pxTri(ctx, cx+hornW, cy-hh+1, cx+hornW+2, cy-hh-hornH, cx+1, cy-hh, pal.horn);
      pxRect(ctx, cx-hornW-1, cy-hh-hornH+2, 1, 3, pal.hornDk);
      pxRect(ctx, cx+hornW+1, cy-hh-hornH+2, 1, 3, pal.hornDk);
      pxRect(ctx, cx-hornW-2, cy-hh-hornH, 1, 2, pal.rune);
      pxRect(ctx, cx+hornW+2, cy-hh-hornH, 1, 2, pal.rune);
    }
    pxEllipse(ctx, cx, cy, hw, hh, pal.furMid);
    pxEllipse(ctx, cx-1, cy-hh+2, hw-3, 2, pal.furLight);
    pxEllipse(ctx, cx-2, cy-hh+3, hw-5, 1, pal.furHi);
    pxEllipse(ctx, cx+snoutX, cy+2, 4, 3, pal.furLight);
    pxEllipse(ctx, cx+snoutX, cy+1, 3, 1, pal.furHi);
    pxRect(ctx, cx+snoutX + dir*3 - 1, cy+1, 2, 2, pal.nose);
    var ey = cy-2;
    var exL = cx-5 + (dir<0?1:0), exR = cx+2 + (dir>0?-1:0);
    if (blink > 0.9) {
      pxRect(ctx, exL, ey+1, 3, 1, pal.outline);
      pxRect(ctx, exR, ey+1, 3, 1, pal.outline);
    } else {
      pxRect(ctx, exL+gx, ey+gy, 3, 2, pal.eye);
      pxRect(ctx, exL+gx, ey+gy, 1, 1, pal.eyeCore);
      pxRect(ctx, exR+gx, ey+gy, 3, 2, pal.eye);
      pxRect(ctx, exR+2+gx, ey+gy, 1, 1, pal.eyeCore);
    }
    var mx = cx + snoutX;
    if (roar) {
      var mw = Math.round(7*s), mh = Math.round(5*s), my = cy+2;
      pxEllipse(ctx, mx, my+mh/2, mw/2, mh/2, pal.mouth);
      pxEllipse(ctx, mx, my+mh/2+1, Math.max(1,mw/2-2), Math.max(1,mh/2-1), pal.tongue);
      pxTri(ctx, mx-mw/2+1, my, mx-mw/2+2, my+3, mx-mw/2+3, my, pal.fang);
      pxTri(ctx, mx+mw/2-3, my, mx+mw/2-2, my+3, mx+mw/2-1, my, pal.fang);
      pxRect(ctx, mx-mw/2+2, my+mh-1, mw-4, 1, pal.fang);
    } else {
      pxRect(ctx, mx-4, cy+4, 8, 1, pal.outline);
      pxTri(ctx, mx+dir*3-1, cy+4, mx+dir*3, cy+6, mx+dir*3+1, cy+4, pal.fang);
    }
  }

  /* ── ULTRA / OMEGA head — gold-rimmed, crown-ready, glowing eyes ──
     crown: 0 none, 1 gold crown crest (ULTRA center), 2 gold ear-inlay + crest (OMEGA) */
  function drawHeadRegal(ctx, cx, cy, o, pal, crown) {
    var dir = o.dir||0, s = o.size||1, roar = o.roar||false, blink = o.blink||0;
    var gx = o.gazeX||0, gy = o.gazeY||0;
    var hw = Math.round(8*s), hh = Math.round(7*s);
    var snoutX = dir * Math.round(4*s);
    pxEllipse(ctx, cx, cy, hw+1, hh+1, pal.outline);
    /* ears — tall pointed, gold-rimmed */
    var earH = Math.round(6*s);
    pxTri(ctx, cx-hw+1, cy-hh+2, cx-hw-2, cy-hh-earH, cx-hw+5, cy-hh, pal.furDark);
    pxTri(ctx, cx+hw-1, cy-hh+2, cx+hw+2, cy-hh-earH, cx+hw-5, cy-hh, pal.furDark);
    if (crown >= 2) {   /* OMEGA: gold inlay on both ear edges */
      pxLine(ctx, cx-hw+1, cy-hh+2, cx-hw-2, cy-hh-earH, 1, pal.gold);
      pxLine(ctx, cx+hw-1, cy-hh+2, cx+hw+2, cy-hh-earH, 1, pal.gold);
    }
    pxRect(ctx, cx-hw, cy-hh-1, 1, 2, pal.earIn);
    pxRect(ctx, cx+hw-1, cy-hh-1, 1, 2, pal.earIn);
    /* skull */
    pxEllipse(ctx, cx, cy, hw, hh, pal.furMid);
    pxEllipse(ctx, cx-1, cy-hh+2, hw-3, 2, pal.furLight);
    pxEllipse(ctx, cx-2, cy-hh+3, hw-5, 1, pal.furHi);
    /* OMEGA: molten lava veins crackling across the cheeks and brow */
    if (crown === 2) {
      pxLine(ctx, cx-Math.round(hw*0.75), cy, cx-Math.round(hw*0.4), cy+3, 1, pal.lava3);
      pxLine(ctx, cx+Math.round(hw*0.75), cy, cx+Math.round(hw*0.4), cy+3, 1, pal.lava3);
      pxLine(ctx, cx-Math.round(hw*0.4), cy+3, cx-Math.round(hw*0.2), cy+5, 1, pal.lava2);
      pxLine(ctx, cx+Math.round(hw*0.4), cy+3, cx+Math.round(hw*0.2), cy+5, 1, pal.lava2);
      pxLine(ctx, cx-Math.round(hw*0.55), cy-hh+4, cx-Math.round(hw*0.25), cy-hh+7, 1, pal.lava2);
      pxLine(ctx, cx+Math.round(hw*0.55), cy-hh+4, cx+Math.round(hw*0.25), cy-hh+7, 1, pal.lava2);
      pxRect(ctx, cx-Math.round(hw*0.4), cy+3, 1, 1, pal.lava4);
      pxRect(ctx, cx+Math.round(hw*0.4), cy+3, 1, 1, pal.lava4);
      pxRect(ctx, cx-Math.round(hw*0.2), cy+5, 1, 1, pal.lava5);
      pxRect(ctx, cx+Math.round(hw*0.2), cy+5, 1, 1, pal.lava5);
    }
    /* gold jaw/cheek spikes — two per side, bright-tipped so they read at scale */
    pxTri(ctx, cx-hw, cy, cx-hw-4, cy+2, cx-hw, cy+4, pal.gold);
    pxTri(ctx, cx-hw+1, cy+3, cx-hw-3, cy+5, cx-hw+1, cy+6, pal.gold);
    pxTri(ctx, cx+hw, cy, cx+hw+4, cy+2, cx+hw, cy+4, pal.gold);
    pxTri(ctx, cx+hw-1, cy+3, cx+hw+3, cy+5, cx+hw-1, cy+6, pal.gold);
    pxRect(ctx, cx-hw-4, cy+2, 1, 1, pal.goldHi);
    pxRect(ctx, cx+hw+4, cy+2, 1, 1, pal.goldHi);
    pxRect(ctx, cx-hw-3, cy+5, 1, 1, pal.goldHi);
    pxRect(ctx, cx+hw+3, cy+5, 1, 1, pal.goldHi);
    /* snout + nose */
    pxEllipse(ctx, cx+snoutX, cy+2, 4, 3, pal.furLight);
    pxEllipse(ctx, cx+snoutX, cy+1, 3, 1, pal.furHi);
    pxRect(ctx, cx+snoutX + dir*3 - 1, cy+1, 2, 2, pal.nose);
    /* crown crest between the ears */
    if (crown === 1) {  /* ULTRA: 3 golden spikes + forehead diamond, dark-rimmed to pop from flames */
      var ch = Math.round(7*s);
      pxEllipse(ctx, cx, cy-hh+1, 7, 2, pal.outline);
      pxTri(ctx, cx, cy-hh-ch, cx-4, cy-hh+1, cx+4, cy-hh+1, pal.gold);
      pxTri(ctx, cx-5, cy-hh-ch+3, cx-8, cy-hh+1, cx-2, cy-hh+1, pal.gold);
      pxTri(ctx, cx+5, cy-hh-ch+3, cx+2, cy-hh+1, cx+8, cy-hh+1, pal.gold);
      pxRect(ctx, cx-1, cy-hh-ch, 2, 3, pal.goldHi);
      pxRect(ctx, cx-6, cy-hh-ch+3, 1, 2, pal.goldHi);
      pxRect(ctx, cx+6, cy-hh-ch+3, 1, 2, pal.goldHi);
      pxDiamond(ctx, cx, cy-hh+3, 3, 4, pal.gem);
      pxRect(ctx, cx, cy-hh+2, 1, 2, pal.gemCore);
      /* tall curved golden horns sweeping up and outward (regal headdress) */
      var hornH = Math.round(10*s);
      pxLine(ctx, cx-hw+1, cy-hh, cx-hw-5, cy-hh-hornH*0.55, 3, pal.gold);
      pxLine(ctx, cx-hw-5, cy-hh-hornH*0.55, cx-hw-10, cy-hh-hornH, 2, pal.gold);
      pxRect(ctx, cx-hw-10, cy-hh-hornH, 1, 2, pal.goldHi);
      pxLine(ctx, cx+hw-1, cy-hh, cx+hw+5, cy-hh-hornH*0.55, 3, pal.gold);
      pxLine(ctx, cx+hw+5, cy-hh-hornH*0.55, cx+hw+10, cy-hh-hornH, 2, pal.gold);
      pxRect(ctx, cx+hw+10, cy-hh-hornH, 1, 2, pal.goldHi);
    } else if (crown === 2) {  /* OMEGA: elaborate flame-spike crown + forehead diamond */
      var ch = Math.round(9*s);
      /* gold base band across the skull, bright-topped */
      pxRect(ctx, cx-Math.round(hw*0.85), cy-hh+1, Math.round(hw*1.7), 2, pal.gold);
      pxRect(ctx, cx-Math.round(hw*0.85), cy-hh+1, Math.round(hw*1.7), 1, pal.goldHi);
      /* central flame spike — tallest, bright-tipped */
      pxTri(ctx, cx, cy-hh-ch, cx-3, cy-hh+2, cx+3, cy-hh+2, pal.gold);
      pxTri(ctx, cx, cy-hh-ch, cx-1, cy-hh-ch+4, cx+1, cy-hh-ch+4, pal.goldHi);
      /* inner side spikes */
      pxTri(ctx, cx-Math.round(4*s), cy-hh-Math.round(6*s), cx-Math.round(6*s), cy-hh+2, cx-Math.round(2*s), cy-hh+2, pal.gold);
      pxTri(ctx, cx+Math.round(4*s), cy-hh-Math.round(6*s), cx+Math.round(2*s), cy-hh+2, cx+Math.round(6*s), cy-hh+2, pal.gold);
      pxRect(ctx, cx-Math.round(4*s), cy-hh-Math.round(6*s), 1, 2, pal.goldHi);
      pxRect(ctx, cx+Math.round(4*s)-1, cy-hh-Math.round(6*s), 1, 2, pal.goldHi);
      /* outer side spikes — shortest */
      pxTri(ctx, cx-Math.round(7*s), cy-hh-Math.round(3*s), cx-Math.round(8*s), cy-hh+2, cx-Math.round(5*s), cy-hh+2, pal.gold);
      pxTri(ctx, cx+Math.round(7*s), cy-hh-Math.round(3*s), cx+Math.round(5*s), cy-hh+2, cx+Math.round(8*s), cy-hh+2, pal.gold);
    }
    /* eyes — glowing with hot core */
    var ey = cy-2;
    var exL = cx-5 + (dir<0?1:0), exR = cx+2 + (dir>0?-1:0);
    if (blink > 0.9) {
      pxRect(ctx, exL, ey+1, 3, 1, pal.outline);
      pxRect(ctx, exR, ey+1, 3, 1, pal.outline);
    } else {
      pxRect(ctx, exL+gx-1, ey+gy-1, 4, 3, pal.eye);
      pxRect(ctx, exL+gx, ey+gy, 2, 1, pal.eyeCore);
      pxRect(ctx, exR+gx-1, ey+gy-1, 4, 3, pal.eye);
      pxRect(ctx, exR+gx+1, ey+gy, 2, 1, pal.eyeCore);
    }
    /* OMEGA: small red diamond motif on the forehead — drawn after the eyes so
       it always reads, set in a gold frame with a white-hot core. Scaled with
       head size so it stays visible on the larger center head. */
    if (crown === 2) {
      var fy = cy-hh+4;
      var fr = Math.max(2, Math.round(2.6*s));
      pxDiamond(ctx, cx, fy, fr+1, fr+1, pal.outline);
      pxDiamond(ctx, cx, fy, fr, fr, pal.gold);
      pxDiamond(ctx, cx, fy, Math.max(1,fr-1), Math.max(1,fr-1), pal.gem);
      pxRect(ctx, cx, fy-1, 1, 1, pal.gemCore);
    }
    /* mouth */
    var mx = cx + snoutX;
    if (roar) {
      var mw = Math.round(8*s), mh = Math.round(6*s), my = cy+2;
      pxEllipse(ctx, mx, my+mh/2, mw/2, mh/2, pal.mouth);
      pxEllipse(ctx, mx, my+mh/2+1, Math.max(1,mw/2-2), Math.max(1,mh/2-1), pal.tongue);
      pxTri(ctx, mx-mw/2+1, my, mx-mw/2+2, my+4, mx-mw/2+3, my, pal.fang);
      pxTri(ctx, mx+mw/2-3, my, mx+mw/2-2, my+4, mx+mw/2-1, my, pal.fang);
      pxRect(ctx, mx-mw/2+2, my+mh-1, mw-4, 1, pal.fang);
    } else {
      pxRect(ctx, mx-4, cy+4, 8, 1, pal.outline);
      pxTri(ctx, mx+dir*3-1, cy+4, mx+dir*3, cy+7, mx+dir*3+1, cy+4, pal.fang);
    }
  }

  /* ══════════════════════ PUP ══════════════════════ */
  function drawPupSide(ctx, P) {
    var W=64,H=52; ctx.clearRect(0,0,W,H);
    var bob=P.bob||0, walk=P.walk||0, flameI=P.flameI==null?1:P.flameI, flick=P.flick||0;
    var gx=P.gazeX||0, gy=P.gazeY||0, squash=P.squash||1, sad=P.sad||0, lean=P.lean||0;
    var x;
    for (x=14; x<=50; x+=4) {
      var hgt=(13+Math.round(3*Math.sin(x*0.3)))*flameI;
      var sway=Math.sin(flick*0.18+x*0.5)*1.2+lean*0.6;
      flameTongue(ctx, x, 27+bob*0.4, Math.max(4,hgt+Math.round(Math.sin(flick*0.28+x)*2)), 6, sway, x);
    }
    var hf=[{x:9,h:16,l:-2},{x:14,h:20,l:-1},{x:19,h:23,l:0},{x:24,h:24,l:0},{x:29,h:22,l:1},{x:34,h:18,l:1}];
    for (var fi=0;fi<hf.length;fi++){var tg=hf[fi];flameTongue(ctx,tg.x,26+bob*0.4,Math.max(5,tg.h*flameI+Math.round(Math.sin(flick*0.28+fi*2.3)*2)),6,Math.sin(flick*0.18+fi*1.7)*1.2+tg.l+lean*0.6,fi);}
    var legAmp=walk?5:0; function legSwing(ph){return Math.round(Math.sin(walk+ph)*legAmp);}
    pxLine(ctx,14+legSwing(0),35,13+legSwing(0),45,4,PAL.furDark); pxRect(ctx,10+legSwing(0),44,6,3,PAL.furDark);
    pxRect(ctx,10+legSwing(0),46,1,2,PAL.claw); pxRect(ctx,13+legSwing(0),46,1,2,PAL.claw);
    pxLine(ctx,39+legSwing(Math.PI),35,41+legSwing(Math.PI),45,4,PAL.furDark); pxRect(ctx,38+legSwing(Math.PI),44,6,3,PAL.furDark);
    pxRect(ctx,38+legSwing(Math.PI),46,1,2,PAL.claw); pxRect(ctx,41+legSwing(Math.PI),46,1,2,PAL.claw);
    var wag=Math.sin((P.tailWag||0))*2;
    pxLine(ctx,47,31,54+wag*0.4,27,3,PAL.furDark); pxLine(ctx,54+wag*0.4,27,57+wag,21,3,PAL.furDark);
    flameTongue(ctx,57+wag,22,7*flameI,4,wag,9);
    pxEllipse(ctx,31,33+bob*0.3,17*squash,7/squash,PAL.furDark);
    pxEllipse(ctx,17,32+bob*0.3,8*squash,7/squash,PAL.furMid);
    pxEllipse(ctx,43,32+bob*0.3,7*squash,7/squash,PAL.furDark);
    pxEllipse(ctx,29,27+bob*0.3,12,2,PAL.furLight);
    pxEllipse(ctx,15,30+bob*0.3,3,3,PAL.furLight);
    pxEllipse(ctx,31,38+bob*0.3,12,2,PAL.furDeep);
    pxLine(ctx,20+legSwing(Math.PI),36,20+legSwing(Math.PI),47,4,PAL.furMid); pxRect(ctx,17+legSwing(Math.PI),46,6,3,PAL.furMid);
    pxRect(ctx,17+legSwing(Math.PI),48,1,2,PAL.claw); pxRect(ctx,20+legSwing(Math.PI),48,1,2,PAL.claw); pxRect(ctx,22+legSwing(Math.PI),48,1,2,PAL.claw);
    pxLine(ctx,44+legSwing(0),35,46+legSwing(0),41,4,PAL.furMid); pxLine(ctx,46+legSwing(0),41,45+legSwing(0),47,3,PAL.furMid);
    pxRect(ctx,42+legSwing(0),46,6,3,PAL.furMid);
    pxRect(ctx,42+legSwing(0),48,1,2,PAL.claw); pxRect(ctx,45+legSwing(0),48,1,2,PAL.claw); pxRect(ctx,47+legSwing(0),48,1,2,PAL.claw);
    var droop=sad*3, nl=-lean;
    pxLine(ctx,11+nl,18+bob*0.8+droop,11,28+bob*0.3,4,PAL.furDark);
    pxLine(ctx,22+nl,14+bob+droop*0.5,22,28+bob*0.3,5,PAL.furDark);
    pxLine(ctx,33+nl,18+bob*0.8+droop,33,28+bob*0.3,4,PAL.furDark);
    var hgx=Math.max(-1,Math.min(1,gx)), hgy=Math.max(-1,Math.min(1,gy));
    drawHead(ctx,11+nl,14+bob*0.8+droop+(lean?1:0),{dir:-1,size:0.9,roar:P.roarSide||false,blink:P.blink,gazeX:hgx,gazeY:hgy});
    drawHead(ctx,22+nl,10+bob+droop*0.5+(lean?1:0),{dir:0,size:1.15,roar:P.roarCenter!==false,blink:P.blink,gazeX:hgx,gazeY:hgy});
    drawHead(ctx,33+nl,14+bob*0.8+droop+(lean?1:0),{dir:1,size:0.9,roar:P.roarSide||false,blink:P.blink,gazeX:hgx,gazeY:hgy});
    if (walk) for (var ei=0;ei<3;ei++){var ex=48+((flick*0.8+ei*9)%14),ey=22+((ei*7+flick*0.3)%16);ctx.fillStyle=ei%2?PAL.flameOrg:PAL.flameYel;ctx.globalAlpha=0.8-(ex-48)/20;ctx.fillRect(Math.round(ex),Math.round(ey),1,1);ctx.globalAlpha=1;}
  }
  function drawPupFront(ctx, P) {
    var W=64,H=52; ctx.clearRect(0,0,W,H);
    var bob=P.bob||0, flameI=P.flameI==null?1:P.flameI, flick=P.flick||0, gx=P.gazeX||0, gy=P.gazeY||0;
    var sad=P.sad||0, droop=sad*3, howl=P.howl||0;
    var hl=P.headL||0, hr=P.headR||0, hc=P.headC||0, headLift=howl*4;
    var hf=[{x:10,h:15,l:-2},{x:16,h:19,l:-1},{x:22,h:22,l:0},{x:27,h:23,l:0},{x:32,h:23,l:0},{x:37,h:22,l:0},{x:42,h:19,l:1},{x:48,h:15,l:2}];
    for (var fi=0;fi<hf.length;fi++){var tg=hf[fi];flameTongue(ctx,tg.x,28+bob*0.4,Math.max(5,tg.h*flameI+Math.round(Math.sin(flick*0.28+fi*2.3)*2)),6,Math.sin(flick*0.18+fi*1.7)*1.2+tg.l,fi);}
    pxEllipse(ctx,32,36+bob*0.3,16,8,PAL.furDark); pxEllipse(ctx,32,33+bob*0.3,10,9,PAL.furMid);
    pxEllipse(ctx,32,28+bob*0.3,6,3,PAL.furLight); pxEllipse(ctx,32,41+bob*0.3,12,2,PAL.furDeep);
    var wag=Math.sin((P.tailWag||0))*3;
    pxLine(ctx,45,35,52+wag*0.4,30,3,PAL.furDark); pxLine(ctx,52+wag*0.4,30,55+wag,23,3,PAL.furDark);
    flameTongue(ctx,55+wag,24,8*flameI,4,wag,9);
    if (P.wave) {
      pxLine(ctx,26,37,25,47,4,PAL.furMid); pxRect(ctx,22,46,6,3,PAL.furMid);
      pxRect(ctx,22,48,1,2,PAL.claw); pxRect(ctx,25,48,1,2,PAL.claw);
      var wv=Math.sin(flick*0.5)*3;
      pxLine(ctx,38,34,42+wv,26,4,PAL.furMid); pxRect(ctx,40+wv,23,5,3,PAL.furMid);
      pxRect(ctx,41+wv,22,1,2,PAL.claw); pxRect(ctx,44+wv,22,1,2,PAL.claw);
    } else {
      pxLine(ctx,26,37,25,47,4,PAL.furMid); pxRect(ctx,22,46,6,3,PAL.furMid);
      pxRect(ctx,22,48,1,2,PAL.claw); pxRect(ctx,25,48,1,2,PAL.claw);
      pxLine(ctx,38,37,39,47,4,PAL.furMid); pxRect(ctx,36,46,6,3,PAL.furMid);
      pxRect(ctx,37,48,1,2,PAL.claw); pxRect(ctx,40,48,1,2,PAL.claw);
    }
    pxLine(ctx,16+hl,20+bob*0.8+droop-headLift,24,30+bob*0.3,4,PAL.furDark);
    pxLine(ctx,32+hc,15+bob+droop*0.5-headLift,32,30+bob*0.3,5,PAL.furDark);
    pxLine(ctx,48+hr,20+bob*0.8+droop-headLift,40,30+bob*0.3,4,PAL.furDark);
    var hgx=Math.max(-1,Math.min(1,gx)), hgy=Math.max(-1,Math.min(1,gy));
    var glx=P.gazeLOverride!=null?P.gazeLOverride:hgx, grx=P.gazeROverride!=null?P.gazeROverride:hgx;
    drawHead(ctx,16+hl,15+bob*0.8+droop-headLift,{dir:-1,size:0.95,roar:P.roarSide||false,blink:P.blink,gazeX:glx,gazeY:hgy});
    drawHead(ctx,32+hc,11+bob+droop*0.5-headLift,{dir:0,size:1.15,roar:P.roarCenter!==false,blink:P.blink,gazeX:hgx,gazeY:hgy});
    drawHead(ctx,48+hr,15+bob*0.8+droop-headLift,{dir:1,size:0.95,roar:P.roarSide||false,blink:P.blink,gazeX:grx,gazeY:hgy});
    if (P.fireBreath) drawFireBreath(ctx, 32, 17, 44, 7, P.fireBreath, flick, PAL);
  }

  /* shared fire-breath cone (scales per form) */
  function drawFireBreath(ctx, cx, topY, botY, spread, fb, flick, pal) {
    for (var by=topY; by<=botY; by++) {
      var bt=(by-topY)/(botY-topY);
      var halfW=(1+bt*spread)*fb;
      var wob=Math.sin(flick*0.4+by*0.7)*bt*1.8;
      var color;
      if (bt<0.25) color=pal.flameCore; else if (bt<0.5) color=pal.flameYel;
      else if (bt<0.78) color=pal.flameOrg; else color=pal.flameRed;
      ctx.fillStyle=color; ctx.globalAlpha=fb*(0.85+0.15*Math.sin(flick*0.5+by));
      ctx.fillRect(Math.round(cx-halfW+wob), by, Math.round(halfW*2), 1); ctx.globalAlpha=1;
    }
    for (var si=0;si<5;si++){var st=((flick*0.6+si*5)%10)/10;var sx=cx+Math.sin(si*9.1)*(2+st*spread*1.3)*fb;var sy=topY+st*(botY-topY)*fb;ctx.fillStyle=si%2?pal.flameYel:pal.flameOrg;ctx.globalAlpha=(1-st)*fb;ctx.fillRect(Math.round(sx),Math.round(sy),1,1);ctx.globalAlpha=1;}
  }

  /* ══════════════════════ PRIME ══════════════════════ */
  function drawPrimeSide(ctx, P) {
    var W=80,H=64; ctx.clearRect(0,0,W,H);
    var pal=PAL2, bob=P.bob||0, walk=P.walk||0, flameI=P.flameI==null?1:P.flameI, flick=P.flick||0;
    var gx=P.gazeX||0, gy=P.gazeY||0, squash=P.squash||1, sad=P.sad||0, lean=P.lean||0;
    var x;
    for (x=16;x<=64;x+=4){var hgt=(17+Math.round(4*Math.sin(x*0.28)))*flameI;flameTongue(ctx,x,34+bob*0.4,Math.max(5,hgt+Math.round(Math.sin(flick*0.28+x)*2)),7,Math.sin(flick*0.18+x*0.5)*1.4+lean*0.6,x,pal);}
    var hf=[{x:11,h:20,l:-2},{x:17,h:25,l:-1},{x:23,h:29,l:0},{x:30,h:30,l:0},{x:36,h:28,l:1},{x:42,h:23,l:1}];
    for (var fi=0;fi<hf.length;fi++){var tg=hf[fi];flameTongue(ctx,tg.x,33+bob*0.4,Math.max(6,tg.h*flameI+Math.round(Math.sin(flick*0.28+fi*2.3)*2)),7,Math.sin(flick*0.18+fi*1.7)*1.4+tg.l+lean*0.6,fi,pal);}
    var legAmp=walk?6:0; function legSwing(ph){return Math.round(Math.sin(walk+ph)*legAmp);}
    pxLine(ctx,18+legSwing(0),44,17+legSwing(0),56,5,pal.furDark); pxRect(ctx,13+legSwing(0),55,7,3,pal.furDark);
    pxRect(ctx,13+legSwing(0),57,1,2,pal.claw); pxRect(ctx,17+legSwing(0),57,1,2,pal.claw);
    pxLine(ctx,49+legSwing(Math.PI),44,51+legSwing(Math.PI),56,5,pal.furDark); pxRect(ctx,47+legSwing(Math.PI),55,7,3,pal.furDark);
    pxRect(ctx,47+legSwing(Math.PI),57,1,2,pal.claw); pxRect(ctx,51+legSwing(Math.PI),57,1,2,pal.claw);
    var wag=Math.sin((P.tailWag||0))*2.5;
    pxLine(ctx,59,39,68+wag*0.4,34,4,pal.furDark); pxLine(ctx,68+wag*0.4,34,72+wag,26,4,pal.furDark);
    flameTongue(ctx,72+wag,27,9*flameI,5,wag,9,pal); flameTongue(ctx,70+wag,30,6*flameI,4,wag,5,pal);
    pxEllipse(ctx,39,42+bob*0.3,21*squash,9/squash,pal.furDark);
    pxEllipse(ctx,21,40+bob*0.3,10*squash,9/squash,pal.furMid);
    pxEllipse(ctx,54,40+bob*0.3,9*squash,9/squash,pal.furDark);
    pxEllipse(ctx,36,34+bob*0.3,15,3,pal.furLight); pxEllipse(ctx,19,38+bob*0.3,4,3,pal.furLight);
    pxEllipse(ctx,39,48+bob*0.3,15,2,pal.furDeep);
    pxEllipse(ctx,21,36+bob*0.3,6,4,pal.armor); pxEllipse(ctx,20,35+bob*0.3,4,2,pal.armorHi); pxRect(ctx,24,37+bob*0.3,2,2,pal.armorDk);
    pxLine(ctx,25+legSwing(Math.PI),45,25+legSwing(Math.PI),58,5,pal.furMid); pxRect(ctx,21+legSwing(Math.PI),57,7,3,pal.furMid);
    pxRect(ctx,21+legSwing(Math.PI),59,1,2,pal.claw); pxRect(ctx,25+legSwing(Math.PI),59,1,2,pal.claw); pxRect(ctx,27+legSwing(Math.PI),59,1,2,pal.claw);
    pxLine(ctx,55+legSwing(0),44,57+legSwing(0),51,5,pal.furMid); pxLine(ctx,57+legSwing(0),51,56+legSwing(0),58,4,pal.furMid);
    pxRect(ctx,52+legSwing(0),57,7,3,pal.furMid);
    pxRect(ctx,52+legSwing(0),59,1,2,pal.claw); pxRect(ctx,56+legSwing(0),59,1,2,pal.claw); pxRect(ctx,58+legSwing(0),59,1,2,pal.claw);
    var droop=sad*3, nl=-lean;
    pxLine(ctx,14+nl,23+bob*0.8+droop,14,36+bob*0.3,5,pal.furDark);
    pxLine(ctx,27+nl,18+bob+droop*0.5,27,36+bob*0.3,6,pal.furDark);
    pxLine(ctx,41+nl,23+bob*0.8+droop,41,36+bob*0.3,5,pal.furDark);
    var hgx=Math.max(-1,Math.min(1,gx)), hgy=Math.max(-1,Math.min(1,gy));
    drawHead2(ctx,14+nl,18+bob*0.8+droop+(lean?1:0),{dir:-1,size:0.95,roar:P.roarSide||false,blink:P.blink,gazeX:hgx,gazeY:hgy});
    drawHead2(ctx,27+nl,13+bob+droop*0.5+(lean?1:0),{dir:0,size:1.2,roar:P.roarCenter!==false,blink:P.blink,gazeX:hgx,gazeY:hgy,horn:true});
    drawHead2(ctx,41+nl,18+bob*0.8+droop+(lean?1:0),{dir:1,size:0.95,roar:P.roarSide||false,blink:P.blink,gazeX:hgx,gazeY:hgy});
    if (walk) for (var ei=0;ei<4;ei++){var ex=60+((flick*0.8+ei*9)%16),ey=28+((ei*7+flick*0.3)%18);ctx.fillStyle=ei%2?pal.flameOrg:pal.flameYel;ctx.globalAlpha=0.8-(ex-60)/22;ctx.fillRect(Math.round(ex),Math.round(ey),1,1);ctx.globalAlpha=1;}
  }
  function drawPrimeFront(ctx, P) {
    var W=80,H=64; ctx.clearRect(0,0,W,H);
    var pal=PAL2, bob=P.bob||0, flameI=P.flameI==null?1:P.flameI, flick=P.flick||0, gx=P.gazeX||0, gy=P.gazeY||0;
    var sad=P.sad||0, droop=sad*3, howl=P.howl||0;
    var hl=P.headL||0, hr=P.headR||0, hc=P.headC||0, headLift=howl*5;
    var hf=[{x:12,h:19,l:-2},{x:20,h:24,l:-1},{x:27,h:28,l:0},{x:34,h:29,l:0},{x:40,h:29,l:0},{x:46,h:28,l:0},{x:53,h:24,l:1},{x:60,h:19,l:2}];
    for (var fi=0;fi<hf.length;fi++){var tg=hf[fi];flameTongue(ctx,tg.x,36+bob*0.4,Math.max(6,tg.h*flameI+Math.round(Math.sin(flick*0.28+fi*2.3)*2)),7,Math.sin(flick*0.18+fi*1.7)*1.4+tg.l,fi,pal);}
    pxEllipse(ctx,40,45+bob*0.3,20,10,pal.furDark); pxEllipse(ctx,40,41+bob*0.3,13,11,pal.furMid);
    pxEllipse(ctx,40,35+bob*0.3,8,4,pal.furLight); pxEllipse(ctx,40,33+bob*0.3,5,2,pal.furHi);
    pxEllipse(ctx,40,52+bob*0.3,15,2,pal.furDeep);
    pxEllipse(ctx,24,40+bob*0.3,7,6,pal.outline); pxEllipse(ctx,24,40+bob*0.3,6,5,pal.armor);
    pxEllipse(ctx,23,39+bob*0.3,4,2,pal.armorHi); pxRect(ctx,26,41+bob*0.3,2,2,pal.armorDk);
    pxEllipse(ctx,56,40+bob*0.3,7,6,pal.outline); pxEllipse(ctx,56,40+bob*0.3,6,5,pal.armor);
    pxEllipse(ctx,55,39+bob*0.3,4,2,pal.armorHi); pxRect(ctx,52,41+bob*0.3,2,2,pal.armorDk);
    var runePulse=P.runeFlare?1:(0.6+0.4*Math.sin(flick*0.12));
    ctx.globalAlpha=runePulse*0.3; pxTri(ctx,40,35+bob*0.3,31,49+bob*0.3,49,49+bob*0.3,pal.rune); ctx.globalAlpha=1;
    pxTri(ctx,40,37+bob*0.3,34,47+bob*0.3,46,47+bob*0.3,pal.rune);
    pxTri(ctx,40,49+bob*0.3,35,41+bob*0.3,45,41+bob*0.3,pal.rune);
    pxRect(ctx,39,41+bob*0.3,2,3,pal.runeCore); pxRect(ctx,39,39+bob*0.3,2,1,pal.flameCore);
    var wag=Math.sin((P.tailWag||0))*3.5;
    pxLine(ctx,56,44,65+wag*0.4,38,4,pal.furDark); pxLine(ctx,65+wag*0.4,38,69+wag,29,4,pal.furDark);
    flameTongue(ctx,69+wag,30,10*flameI,5,wag,9,pal); flameTongue(ctx,67+wag,33,7*flameI,4,wag,5,pal);
    if (P.wave) {
      pxLine(ctx,33,46,32,58,5,pal.furMid); pxRect(ctx,28,57,7,3,pal.furMid);
      pxRect(ctx,28,59,1,2,pal.claw); pxRect(ctx,32,59,1,2,pal.claw);
      var wv=Math.sin(flick*0.5)*3.5;
      pxLine(ctx,48,42,53+wv,32,5,pal.furMid); pxRect(ctx,51+wv,29,6,3,pal.furMid);
      pxRect(ctx,52+wv,28,1,2,pal.claw); pxRect(ctx,56+wv,28,1,2,pal.claw);
    } else {
      pxLine(ctx,33,46,32,58,5,pal.furMid); pxRect(ctx,28,57,7,3,pal.furMid);
      pxRect(ctx,28,59,1,2,pal.claw); pxRect(ctx,32,59,1,2,pal.claw);
      pxLine(ctx,48,46,49,58,5,pal.furMid); pxRect(ctx,45,57,7,3,pal.furMid);
      pxRect(ctx,46,59,1,2,pal.claw); pxRect(ctx,50,59,1,2,pal.claw);
    }
    pxLine(ctx,20+hl,25+bob*0.8+droop-headLift,30,38+bob*0.3,5,pal.furDark);
    pxLine(ctx,40+hc,19+bob+droop*0.5-headLift,40,38+bob*0.3,6,pal.furDark);
    pxLine(ctx,60+hr,25+bob*0.8+droop-headLift,50,38+bob*0.3,5,pal.furDark);
    var hgx=Math.max(-1,Math.min(1,gx)), hgy=Math.max(-1,Math.min(1,gy));
    var glx=P.gazeLOverride!=null?P.gazeLOverride:hgx, grx=P.gazeROverride!=null?P.gazeROverride:hgx;
    drawHead2(ctx,20+hl,19+bob*0.8+droop-headLift,{dir:-1,size:1.0,roar:P.roarSide||false,blink:P.blink,gazeX:glx,gazeY:hgy});
    drawHead2(ctx,40+hc,14+bob+droop*0.5-headLift,{dir:0,size:1.25,roar:P.roarCenter!==false,blink:P.blink,gazeX:hgx,gazeY:hgy,horn:true});
    drawHead2(ctx,60+hr,19+bob*0.8+droop-headLift,{dir:1,size:1.0,roar:P.roarSide||false,blink:P.blink,gazeX:grx,gazeY:hgy});
    if (P.runeFlare) for (var oi=0;oi<5;oi++){var ang=flick*0.15+oi*(Math.PI*2/5);ctx.fillStyle=oi%2?pal.flameYel:pal.rune;ctx.globalAlpha=0.9;ctx.fillRect(Math.round(40+Math.cos(ang)*26),Math.round(20+Math.sin(ang)*10),2,2);ctx.globalAlpha=1;}
    if (P.fireBreath) drawFireBreath(ctx, 40, 22, 55, 9, P.fireBreath, flick, pal);
  }

  /* ══════════════════════ ULTRA — lava-cracked obsidian + gold regalia ══════════════════════ */
  function ultraCracks(ctx, cx, cy, flick, pal) {
    /* dense glowing magma-vein network — the ULTRA signature. bright orange
       veins with yellow-white hot junction nodes that pulse with the breath. */
    var pulse = 0.75 + 0.25*Math.sin(flick*0.12);
    var veins = [
      [cx-17,cy-6, cx-9,cy-1, cx-2,cy+3],
      [cx+17,cy-6, cx+9,cy-1, cx+2,cy+3],
      [cx-13,cy+5, cx-6,cy+8, cx+1,cy+7, cx+8,cy+9],
      [cx-10,cy+9, cx-3,cy+11, cx+5,cy+10],
      [cx,cy-9, cx-1,cy-2, cx+1,cy+4, cx,cy+9],
      [cx-14,cy+1, cx-7,cy+3, cx,cy+1],
      [cx+14,cy+1, cx+7,cy+3, cx,cy+2],
      [cx-6,cy-5, cx-3,cy-1, cx-5,cy+4],
      [cx+6,cy-5, cx+3,cy-1, cx+5,cy+4],
      [cx-20,cy-9, cx-12,cy-6, cx-6,cy-8],
      [cx+20,cy-9, cx+12,cy-6, cx+6,cy-8],
      [cx-9,cy-10, cx-4,cy-7, cx-8,cy-3],
      [cx+9,cy-10, cx+4,cy-7, cx+8,cy-3],
      [cx-16,cy+8, cx-11,cy+5, cx-14,cy+1],
      [cx+16,cy+8, cx+11,cy+5, cx+14,cy+1]
    ];
    for (var v=0; v<veins.length; v++) {
      var vn = veins[v];
      for (var sgm=0; sgm<vn.length-2; sgm+=2) {
        pxLine(ctx, vn[sgm], vn[sgm+1], vn[sgm+2], vn[sgm+3], 1, pal.lava3);
      }
    }
    ctx.globalAlpha = pulse;
    var nodes = [[cx-9,cy-1],[cx+9,cy-1],[cx-2,cy+3],[cx+2,cy+3],[cx,cy-2],[cx-6,cy+8],[cx+5,cy+7],[cx,cy+4],[cx-7,cy+3],[cx+7,cy+3],[cx-3,cy-1],[cx+3,cy-1]];
    for (var n=0; n<nodes.length; n++) {
      pxRect(ctx, nodes[n][0], nodes[n][1], 1, 1, n%3===0 ? pal.lava5 : pal.lava4);
    }
    ctx.globalAlpha = 1;
  }
  function ultraBracer(ctx, x, y, pal) {
    /* segmented thorned vambrace: dark-rimmed cuff + jagged dorsal plate, 2 fin spikes */
    pxEllipse(ctx, x, y, 5, 4, pal.outline);
    pxEllipse(ctx, x, y, 4, 3, pal.goldDk);
    pxEllipse(ctx, x, y, 3, 2, pal.gold);
    pxRect(ctx, x-1, y-1, 2, 1, pal.goldHi);
    /* three dark-outlined metallic spikes (outline behind each for contrast) */
    pxTri(ctx, x-4, y-2, x-8, y-9, x-1, y-3, pal.outline);
    pxTri(ctx, x-4, y-2, x-7, y-8, x-1, y-3, pal.gold);
    pxTri(ctx, x+4, y-2, x+8, y-9, x+1, y-3, pal.outline);
    pxTri(ctx, x+4, y-2, x+7, y-8, x+1, y-3, pal.gold);
    pxTri(ctx, x, y-3, x-2, y-9, x+2, y-9, pal.outline);
    pxTri(ctx, x, y-3, x-2, y-8, x+2, y-8, pal.gold);
    pxRect(ctx, x-7, y-8, 1, 2, pal.goldHi);
    pxRect(ctx, x+7, y-8, 1, 2, pal.goldHi);
    pxRect(ctx, x, y-8, 1, 2, pal.goldHi);
  }
  function ultraChestGem(ctx, cx, cy, flick, pal, flare) {
    /* BIG, SIMPLE, BRIGHT red diamond — at sprite scale, contrast beats detail.
       solid bright red pops against the dark obsidian body; white-hot center;
       thin gold outline frames it. no complex layering that muddies at scale. */
    var pulse = flare ? 1 : (0.75 + 0.25*Math.sin(flick*0.12));
    /* soft red glow halo behind */
    ctx.globalAlpha = pulse*0.35;
    pxDiamond(ctx, cx, cy, 12, 10, pal.gemHalo);
    ctx.globalAlpha = 1;
    /* thin gold outline frame (1px bigger than the gem on each axis) */
    pxDiamond(ctx, cx, cy, 10, 8, pal.gold);
    /* the gem — solid bright red, wider than tall, unmistakable ◆ */
    pxDiamond(ctx, cx, cy, 9, 7, "#e01a0a");
    pxDiamond(ctx, cx, cy, 6, 5, "#ff3a1a");
    /* white-hot facet highlight + center */
    pxDiamond(ctx, cx-2, cy-2, 2, 2, pal.gemCore);
    pxRect(ctx, cx, cy, 1, 1, "#ffffff");
  }
  function ultraTailSpade(ctx, x0, y0, wag, flick, flameI, pal) {
    /* left tail — curls up, ends in a spade/arrowhead finial */
    pxLine(ctx, x0, y0, x0-6, y0-4, 3, pal.furDark);
    pxLine(ctx, x0-6, y0-4, x0-9+wag*0.3, y0-11, 3, pal.furDark);
    var tx=x0-9+wag*0.3, ty=y0-11;
    pxTri(ctx, tx, ty-5, tx-3, ty, tx+3, ty, pal.furMid);   /* spade blade */
    pxTri(ctx, tx-3, ty, tx-5, ty-2, tx-2, ty-1, pal.furMid); /* left barb */
    pxTri(ctx, tx+3, ty, tx+5, ty-2, tx+2, ty-1, pal.furMid); /* right barb */
    pxRect(ctx, tx, ty-5, 1, 1, pal.lava3);
  }
  function ultraTailBarb(ctx, x0, y0, wag, flick, flameI, pal) {
    /* right tail — S-curve, ends in a hooked barbed multi-spike tuft */
    pxLine(ctx, x0, y0, x0+6, y0-3, 3, pal.furDark);
    pxLine(ctx, x0+6, y0-3, x0+4+wag*0.3, y0-9, 3, pal.furDark);
    pxLine(ctx, x0+4+wag*0.3, y0-9, x0+9+wag, y0-13, 3, pal.furDark);
    var tx=x0+9+wag, ty=y0-13;
    pxTri(ctx, tx, ty-4, tx-2, ty+1, tx+2, ty+1, pal.furMid);
    pxTri(ctx, tx+2, ty-2, tx+5, ty-4, tx+3, ty, pal.furMid);
    pxTri(ctx, tx-2, ty-2, tx-5, ty-4, tx-3, ty, pal.furMid);
    flameTongue(ctx, tx, ty-2, 5*flameI, 3, wag*0.5, 7, pal);
  }
  function drawUltraFront(ctx, P) {
    var W=96,H=76; ctx.clearRect(0,0,W,H);
    var pal=PAL3, bob=P.bob||0, flameI=P.flameI==null?1:P.flameI, flick=P.flick||0, gx=P.gazeX||0, gy=P.gazeY||0;
    var sad=P.sad||0, droop=sad*3, howl=P.howl||0;
    var hl=P.headL||0, hr=P.headR||0, hc=P.headC||0, headLift=howl*6;
    /* roaring flame wall behind — 5-band, taller */
    var hf=[{x:14,h:24,l:-2},{x:24,h:30,l:-1},{x:33,h:35,l:0},{x:42,h:37,l:0},{x:48,h:37,l:0},{x:54,h:37,l:0},{x:63,h:35,l:0},{x:72,h:30,l:1},{x:82,h:24,l:2}];
    for (var fi=0;fi<hf.length;fi++){var tg=hf[fi];flameTongue5(ctx,tg.x,44+bob*0.4,Math.max(8,tg.h*flameI+Math.round(Math.sin(flick*0.28+fi*2.3)*3)),8,Math.sin(flick*0.18+fi*1.7)*1.6+tg.l,fi,pal);}
    /* molten ground fissures — tapered at the edges so no hard canvas rectangle */
    pxRect(ctx, 18, H-4, W-36, 3, pal.furDeep);
    for (var gx2=22; gx2<W-22; gx2+=9) { pxRect(ctx, gx2, H-3, 4, 1, pal.lava3); pxRect(ctx, gx2+1, H-3, 2, 1, pal.lava4); }
    pxRect(ctx, W/2-1, H-4, 2, 3, pal.lava4);
    /* torso */
    pxEllipse(ctx,48,54+bob*0.3,24,12,pal.furDark); pxEllipse(ctx,48,49+bob*0.3,16,13,pal.furMid);
    pxEllipse(ctx,48,42+bob*0.3,10,5,pal.furLight); pxEllipse(ctx,48,40+bob*0.3,6,2,pal.furHi);
    pxEllipse(ctx,48,63+bob*0.3,18,2,pal.furDeep);
    ultraCracks(ctx, 48, 50+bob*0.3, flick, pal);
    /* dual tails */
    var wag=Math.sin((P.tailWag||0))*4;
    ultraTailSpade(ctx, 28, 52, wag, flick, flameI, pal);
    ultraTailBarb(ctx, 68, 52, wag, flick, flameI, pal);
    /* golden V-chevron breastplate (reference: ornate gold armor). Arms are
       wide + thick so they extend beyond the gem's frame and read as a V plate */
    /* front legs + spiked bracers + 4 gold talons */
    if (P.wave) {
      pxLine(ctx,40,55,39,69,6,pal.furMid); pxRect(ctx,34,68,8,3,pal.furMid); ultraBracer(ctx,39,62,pal);
      for (var c1=0;c1<4;c1++) pxRect(ctx,34+c1*2,71,1,2,pal.claw);
      var wv=Math.sin(flick*0.5)*4;
      pxLine(ctx,58,50,64+wv,38,6,pal.furMid); pxRect(ctx,62+wv,35,7,3,pal.furMid); ultraBracer(ctx,62+wv,44,pal);
      for (var c2=0;c2<4;c2++) pxRect(ctx,62+wv+c2*2,34,1,2,pal.claw);
    } else {
      pxLine(ctx,40,55,39,69,6,pal.furMid); pxRect(ctx,34,68,8,3,pal.furMid); ultraBracer(ctx,39,62,pal);
      for (var c3=0;c3<4;c3++) pxRect(ctx,34+c3*2,71,1,2,pal.claw);
      pxLine(ctx,58,55,59,69,6,pal.furMid); pxRect(ctx,55,68,8,3,pal.furMid); ultraBracer(ctx,58,62,pal);
      for (var c4=0;c4<4;c4++) pxRect(ctx,55+c4*2,71,1,2,pal.claw);
    }
    /* necks + three regal heads (center wears the gold crown crest) */
    pxLine(ctx,24+hl,30+bob*0.8+droop-headLift,36,46+bob*0.3,5,pal.furDark);
    pxLine(ctx,48+hc,23+bob+droop*0.5-headLift,48,46+bob*0.3,7,pal.furDark);
    pxLine(ctx,72+hr,30+bob*0.8+droop-headLift,60,46+bob*0.3,5,pal.furDark);
    var hgx=Math.max(-1,Math.min(1,gx)), hgy=Math.max(-1,Math.min(1,gy));
    var glx=P.gazeLOverride!=null?P.gazeLOverride:hgx, grx=P.gazeROverride!=null?P.gazeROverride:hgx;
    drawHeadRegal(ctx,24+hl,23+bob*0.8+droop-headLift,{dir:-1,size:1.0,roar:P.roarSide||false,blink:P.blink,gazeX:glx,gazeY:hgy},pal,0);
    drawHeadRegal(ctx,48+hc,17+bob+droop*0.5-headLift,{dir:0,size:1.3,roar:P.roarCenter!==false,blink:P.blink,gazeX:hgx,gazeY:hgy},pal,1);
    drawHeadRegal(ctx,72+hr,23+bob*0.8+droop-headLift,{dir:1,size:1.0,roar:P.roarSide||false,blink:P.blink,gazeX:grx,gazeY:hgy},pal,0);
    /* golden V-chevron breastplate + chest gem — drawn after the necks/heads so
       the plate sits in front (anatomically correct) and is never occluded.
       Arms start wide (outside the gem frame) so the V reads clearly. */
    pxLine(ctx, 24, 38+bob*0.3, 48, 66+bob*0.3, 4, pal.gold);
    pxLine(ctx, 72, 38+bob*0.3, 48, 66+bob*0.3, 4, pal.gold);
    pxLine(ctx, 25, 38+bob*0.3, 48, 65+bob*0.3, 1, pal.goldHi);
    pxLine(ctx, 71, 38+bob*0.3, 48, 65+bob*0.3, 1, pal.goldHi);
    pxTri(ctx, 48, 66+bob*0.3, 44, 72+bob*0.3, 52, 72+bob*0.3, pal.gold);   /* pendant tip */
    pxRect(ctx, 48, 67+bob*0.3, 1, 2, pal.goldHi);
    ultraChestGem(ctx, 48, 48+bob*0.3, flick, pal, P.runeFlare);
    if (P.runeFlare) for (var oi=0;oi<6;oi++){var ang=flick*0.15+oi*(Math.PI*2/6);ctx.fillStyle=oi%2?pal.flameYel:pal.gem;ctx.globalAlpha=0.9;ctx.fillRect(Math.round(48+Math.cos(ang)*32),Math.round(24+Math.sin(ang)*12),2,2);ctx.globalAlpha=1;}
    if (P.fireBreath) drawFireBreath(ctx, 48, 26, 66, 11, P.fireBreath, flick, pal);
  }
  function drawUltraSide(ctx, P) {
    var W=96,H=76; ctx.clearRect(0,0,W,H);
    var pal=PAL3, bob=P.bob||0, walk=P.walk||0, flameI=P.flameI==null?1:P.flameI, flick=P.flick||0;
    var gx=P.gazeX||0, gy=P.gazeY||0, squash=P.squash||1, sad=P.sad||0, lean=P.lean||0;
    var x;
    for (x=18;x<=76;x+=5){var hgt=(21+Math.round(5*Math.sin(x*0.26)))*flameI;flameTongue5(ctx,x,42+bob*0.4,Math.max(7,hgt+Math.round(Math.sin(flick*0.28+x)*3)),8,Math.sin(flick*0.18+x*0.5)*1.6+lean*0.6,x,pal);}
    var hf=[{x:13,h:24,l:-2},{x:20,h:30,l:-1},{x:28,h:35,l:0},{x:36,h:36,l:0},{x:43,h:33,l:1},{x:50,h:27,l:1}];
    for (var fi=0;fi<hf.length;fi++){var tg=hf[fi];flameTongue5(ctx,tg.x,41+bob*0.4,Math.max(8,tg.h*flameI+Math.round(Math.sin(flick*0.28+fi*2.3)*3)),8,Math.sin(flick*0.18+fi*1.7)*1.6+tg.l+lean*0.6,fi,pal);}
    pxRect(ctx, 20, H-4, W-40, 3, pal.furDeep);
    for (var gx2=24; gx2<W-24; gx2+=10) pxRect(ctx, gx2, H-3, 4, 1, pal.lava3);
    var legAmp=walk?7:0; function legSwing(ph){return Math.round(Math.sin(walk+ph)*legAmp);}
    pxLine(ctx,22+legSwing(0),52,21+legSwing(0),66,6,pal.furDark); pxRect(ctx,16+legSwing(0),65,8,3,pal.furDark); ultraBracer(ctx,21+legSwing(0),60,pal);
    for (var c1=0;c1<4;c1++) pxRect(ctx,16+legSwing(0)+c1*2,68,1,2,pal.claw);
    pxLine(ctx,58+legSwing(Math.PI),52,60+legSwing(Math.PI),66,6,pal.furDark); pxRect(ctx,55+legSwing(Math.PI),65,8,3,pal.furDark); ultraBracer(ctx,60+legSwing(Math.PI),60,pal);
    for (var c2=0;c2<4;c2++) pxRect(ctx,55+legSwing(Math.PI)+c2*2,68,1,2,pal.claw);
    var wag=Math.sin((P.tailWag||0))*3;
    ultraTailBarb(ctx, 70, 48, wag, flick, flameI, pal);
    pxEllipse(ctx,46,50+bob*0.3,25*squash,11/squash,pal.furDark);
    pxEllipse(ctx,25,48+bob*0.3,12*squash,11/squash,pal.furMid);
    pxEllipse(ctx,64,48+bob*0.3,11*squash,11/squash,pal.furDark);
    pxEllipse(ctx,43,41+bob*0.3,18,3,pal.furLight); pxEllipse(ctx,23,45+bob*0.3,5,3,pal.furLight);
    pxEllipse(ctx,46,58+bob*0.3,18,2,pal.furDeep);
    ultraCracks(ctx, 46, 49+bob*0.3, flick, pal);
    pxEllipse(ctx,25,44+bob*0.3,7,5,pal.outline); pxEllipse(ctx,25,44+bob*0.3,6,4,pal.gold); pxEllipse(ctx,24,43+bob*0.3,4,2,pal.goldHi);
    pxLine(ctx,30+legSwing(Math.PI),53,30+legSwing(Math.PI),68,6,pal.furMid); pxRect(ctx,25+legSwing(Math.PI),67,8,3,pal.furMid); ultraBracer(ctx,30+legSwing(Math.PI),61,pal);
    for (var c3=0;c3<4;c3++) pxRect(ctx,25+legSwing(Math.PI)+c3*2,70,1,2,pal.claw);
    pxLine(ctx,65+legSwing(0),52,67+legSwing(0),60,6,pal.furMid); pxLine(ctx,67+legSwing(0),60,66+legSwing(0),68,5,pal.furMid);
    pxRect(ctx,62+legSwing(0),67,8,3,pal.furMid); ultraBracer(ctx,66+legSwing(0),61,pal);
    for (var c4=0;c4<4;c4++) pxRect(ctx,62+legSwing(0)+c4*2,70,1,2,pal.claw);
    var droop=sad*3, nl=-lean;
    pxLine(ctx,17+nl,28+bob*0.8+droop,17,44+bob*0.3,6,pal.furDark);
    pxLine(ctx,32+nl,22+bob+droop*0.5,32,44+bob*0.3,7,pal.furDark);
    pxLine(ctx,48+nl,28+bob*0.8+droop,48,44+bob*0.3,6,pal.furDark);
    var hgx=Math.max(-1,Math.min(1,gx)), hgy=Math.max(-1,Math.min(1,gy));
    drawHeadRegal(ctx,17+nl,22+bob*0.8+droop+(lean?1:0),{dir:-1,size:1.0,roar:P.roarSide||false,blink:P.blink,gazeX:hgx,gazeY:hgy},pal,0);
    drawHeadRegal(ctx,32+nl,16+bob+droop*0.5+(lean?1:0),{dir:0,size:1.25,roar:P.roarCenter!==false,blink:P.blink,gazeX:hgx,gazeY:hgy},pal,1);
    drawHeadRegal(ctx,48+nl,22+bob*0.8+droop+(lean?1:0),{dir:1,size:1.0,roar:P.roarSide||false,blink:P.blink,gazeX:hgx,gazeY:hgy},pal,0);
    if (walk) for (var ei=0;ei<5;ei++){var ex=70+((flick*0.8+ei*9)%18),ey=32+((ei*7+flick*0.3)%20);ctx.fillStyle=ei%2?pal.flameOrg:pal.flameYel;ctx.globalAlpha=0.8-(ex-70)/24;ctx.fillRect(Math.round(ex),Math.round(ey),1,1);ctx.globalAlpha=1;}
  }

  /* ══════════════════════ OMEGA — polished obsidian + gold inlay, CRT aura ══════════════════════ */
  /* ══════════════════ OMEGA CERBERUS — heraldic front-facing key art ══════════════════
     Front-facing, chest-out, rigidly mirror-symmetric, cropped at the forelimbs.
     Drawn in logical 160x160 space (res:3 -> 480x480 buffer). Animation is per-part:
     breathing, flame advection, lava-seam pulse, gem throb, independent head yaw +
     staggered blink, jaw chatter, claw flex, crest flicker — all driven off P.flick. */

  /* ── backdrop: discrete sculpted flame tongues, full bleed, black negative space ── */
  function omegaFlameWall(ctx, W, H, flick, pal, flameI) {
    flameI = flameI==null?1:flameI;
    var groundY = H-16;
    /* deep ambient glow, hottest at the creature's waist height */
    var g = ctx.createRadialGradient(W/2, H*0.62, 10, W/2, H*0.62, W*0.62);
    g.addColorStop(0, "rgba(255,110,26,0.34)");
    g.addColorStop(0.55, "rgba(214,64,14,0.16)");
    g.addColorStop(1, "rgba(120,20,4,0)");
    ctx.fillStyle = g; ctx.fillRect(0,0,W,H);
    /* continuous heat band — the tongues merge into a solid sheet at waist
       height (brightest there), so only their tips keep black negative space.
       Fades to transparent well above the waist so the top stays dark. */
    var band = ctx.createLinearGradient(0, groundY, 0, H*0.42);
    band.addColorStop(0, "rgba(255,138,32,0.60)");
    band.addColorStop(0.35, "rgba(232,84,16,0.42)");
    band.addColorStop(0.7, "rgba(160,40,8,0.20)");
    band.addColorStop(1, "rgba(120,24,4,0)");
    ctx.fillStyle = band; ctx.fillRect(0, Math.round(H*0.42), W, groundY-H*0.42);
    /* discrete sinuous tongues — each with its own phase offset (col*0.7) so
       neighbours lean opposite ways, its own advection speed, and a seeded
       height (stable across frames — no strobing). Width tapers to 1px at the
       tip. Black negative space survives between the tips. */
    for (var i=0;i<13;i++){
      var fx = 4 + i*((W-8)/12) + ((i%3)-1)*2;   /* stagger bases off-axis */
      var ph = i*1.2;                              /* larger phase gap → neighbours lean opposite */
      var spd = 0.10 + (i%4)*0.03;
      var cBoost = 1 + 0.45*Math.cos(((fx-W/2)/(W/2))*Math.PI/2);   /* taller at center */
      var hgt = (42 + 30*Math.abs(Math.sin(i*2.3+1)) + 8*Math.sin(flick*spd+ph)) * flameI * cBoost;
      hgt = Math.max(10, Math.round(hgt));
      flameTongueSin(ctx, fx, groundY, hgt, 12, 9, ph, flick*spd, i*7, pal);
      /* a few tongues shed free-floating embers above their tips */
      if (i % 3 === 0) {
        var tipX = Math.round(fx + 4.5*Math.sin(1 + ph + flick*spd));
        var tipY = groundY - hgt;
        for (var em=0; em<2; em++) {
          var ey2 = tipY - 4 - em*5 - ((Math.round(flick*0.6)+i*3+em*7) % 6);
          var ex2 = tipX + Math.round(Math.sin(flick*0.15 + i + em*2.4)*2);
          ctx.globalAlpha = 0.35 + 0.4*Math.sin(flick*0.2 + i + em*1.7);
          pxRect(ctx, ex2, ey2, 1, 1, em%2?pal.flameOrg:pal.flameYel);
        }
        ctx.globalAlpha = 1;
      }
    }
    /* inner hotter layer, offset from the outer tongues for depth */
    for (var j=0;j<8;j++){
      var fx2 = 14 + j*((W-28)/7);
      var ph2 = j*0.7+3.1;
      var hgt2 = (28 + 20*Math.abs(Math.sin(j*3.1)) + 6*Math.sin(flick*(0.12+(j%3)*0.04)+ph2)) * flameI;
      hgt2 = Math.max(8, Math.round(hgt2));
      flameTongueSin(ctx, fx2, groundY, hgt2, 7, 4.5, ph2, flick*(0.12+(j%3)*0.04), j*11+3, pal);
    }
    /* embers drifting in the black zone above the flames (behind the silhouette) */
    for (var e=0;e<16;e++){
      var ex = (e*23 + Math.round(flick*0.5)) % W;
      var ey = 4 + ((e*31 + Math.round(flick*0.8)) % 44);
      ctx.globalAlpha = 0.35 + 0.4*Math.sin(flick*0.2+e*1.9);
      ctx.fillStyle = e%3===0?pal.lava5:(e%3===1?pal.flameOrg:pal.flameYel);
      ctx.fillRect(ex, ey, 1, 1);
    }
    ctx.globalAlpha = 1;
  }

  /* ── ground: cracked lava crust, full bleed, seams pulse out of phase ── */
  function omegaLavaCrust(ctx, W, H, flick, pal) {
    var gy = H-16;
    ctx.fillStyle = "#1c0d07"; ctx.fillRect(0, gy, W, H-gy);
    ctx.fillStyle = "#150a05"; ctx.fillRect(0, gy+6, W, H-gy-6);
    ctx.fillStyle = "#2a160c"; ctx.fillRect(0, gy, W, 1);
    /* glowing fissure web — each seam pulses on its own phase */
    var seams = [
      [0,gy+3, 26,gy+2, 52,gy+4],
      [52,gy+4, 80,gy+3, 108,gy+5],
      [108,gy+5, 134,gy+3, 160,gy+4],
      [26,gy+2, 22,gy+8, 30,gy+13],
      [80,gy+3, 84,gy+9, 76,gy+14],
      [134,gy+3, 138,gy+9, 130,gy+13],
      [52,gy+4, 48,gy+10, 56,gy+14]
    ];
    for (var s=0;s<seams.length;s++){
      var sm = seams[s];
      var pulse = 0.55 + 0.45*Math.sin(flick*0.11 + s*1.3);
      ctx.globalAlpha = pulse;
      for (var sg=0; sg<sm.length-2; sg+=2){
        pxLine(ctx, sm[sg],sm[sg+1], sm[sg+2],sm[sg+3], 2, pal.lava2);
        pxLine(ctx, sm[sg],sm[sg+1], sm[sg+2],sm[sg+3], 1, s%2?pal.lava3:pal.lava4);
      }
    }
    ctx.globalAlpha = 1;
    /* hot pooling glow directly under the creature (the key light) */
    var hg = ctx.createRadialGradient(W/2, gy+4, 2, W/2, gy+4, 34);
    hg.addColorStop(0, "rgba(255,150,40,0.5)");
    hg.addColorStop(1, "rgba(255,90,20,0)");
    ctx.fillStyle = hg; ctx.fillRect(W/2-36, gy, 72, H-gy);
    /* bright nodes at seam junctions */
    var nodes=[[26,gy+2],[80,gy+3],[134,gy+3],[52,gy+4],[108,gy+5]];
    for (var n=0;n<nodes.length;n++){
      ctx.globalAlpha = 0.6+0.4*Math.sin(flick*0.14+n);
      pxRect(ctx, nodes[n][0], nodes[n][1], 1,1, n%2?pal.lava5:pal.lava4);
    }
    ctx.globalAlpha = 1;
  }

  /* ── hide: overlapping molten muscle lobes — near-black warm charcoal bodies
     separated entirely by heat (gold/ember seams), never by gray value steps ── */
  function omegaScales(ctx, cx, cy, cols, rows, cell, pal) {
    /* overlapping molten muscle lobes, NOT a brick grid. Two passes so the seams
       are never overdrawn: (1) lay down every warm-charcoal plate body, then
       (2) paint the valley seams as GLOWING ember lines on top. Plate separation
       is defined entirely by heat — no gray-on-gray edges anywhere. */
    var plates = [];
    for (var r=0;r<rows;r++){
      var off = (r%2)? cell*0.55 : 0;
      for (var c=0;c<cols;c++){
        var sd = r*13 + c*7 + 3;
        var wob = ((sd*2654435761)>>>0) % 100 / 100;
        var wJit = 0.82 + wob*0.36;
        var xJit = (wob-0.5)*cell*0.5;
        var yJit = (((sd*40503)>>>0)%100/100 - 0.5)*cell*0.3;
        plates.push({
          x: cx - (cols*cell)/2 + c*cell + off + xJit,
          y: cy + r*(cell*0.85) + yJit,
          rw: cell*0.55*wJit, rh: cell*0.42, cell: cell
        });
      }
    }
    /* pass 1 — warm near-black charcoal bodies with a warm top facet */
    for (var p=0;p<plates.length;p++){
      var pl = plates[p];
      pxEllipse(ctx, pl.x+pl.cell/2, pl.y+pl.cell*0.4, pl.rw, pl.rh, pal.furDark);
      pxEllipse(ctx, pl.x+pl.cell/2, pl.y+pl.cell*0.28, pl.rw*0.72, pl.rh*0.6, pal.furMid);
    }
    /* pass 2 — molten valley seams (drawn on top so they always read).
       Each seam: red halo -> orange -> gold -> hot core, like lava bleeding
       through a crack. Plus a faint warm top rim-light on each lobe. */
    for (var q=0;q<plates.length;q++){
      var pl2 = plates[q];
      var lx0 = pl2.x+pl2.cell*0.06, lx1 = pl2.x+pl2.cell*0.94;
      var sy = pl2.y+pl2.cell*0.66;
      pxLine(ctx, lx0, sy+2, lx1, sy+2, 1, pal.lava1);      /* deep red halo */
      pxLine(ctx, lx0, sy+1, lx1, sy+1, 1, pal.lava2);      /* ember */
      pxLine(ctx, lx0+1, sy, lx1-1, sy, 1, pal.lava3);      /* orange */
      pxLine(ctx, lx0+2, sy-1, lx1-2, sy-1, 1, pal.lava4);  /* gold */
      pxRect(ctx, Math.round(pl2.x+pl2.cell*0.4), Math.round(sy-1), 3, 1, pal.lava5); /* hot core */
      /* top rim-light catching the fire from above */
      pxLine(ctx, pl2.x+pl2.cell*0.3, pl2.y+pl2.cell*0.12, pl2.x+pl2.cell*0.7, pl2.y+pl2.cell*0.12, 1, pal.furHi);
    }
  }

  /* ── chest: 4-tier gold regalia converging on a red gem with a white-hot slit ── */
  function omegaChestPlate(ctx, cx, cy, flick, pal, flare, breathe) {
    var pulse = flare?1:(0.7+0.3*Math.sin(flick*0.12));
    var throb = 1 + 0.06*Math.sin(flick*0.1);
    var by = cy + breathe;
    /* tier 1 — spiked neck collar ringing the base of the center neck */
    for (var cs=0; cs<7; cs++){
      var csx = cx-18 + cs*6;
      pxTri(ctx, csx, by-16, csx-3, by-8, csx+3, by-8, pal.outline);
      pxTri(ctx, csx, by-15, csx-2, by-8, csx+2, by-8, pal.gold);
      pxRect(ctx, csx, by-15, 1, 2, pal.goldHi);
    }
    pxRect(ctx, cx-20, by-9, 40, 2, pal.goldDk);
    pxRect(ctx, cx-20, by-9, 40, 1, pal.gold);
    /* tier 2 — chain V: discrete links from each shoulder down to the gem */
    for (var lk=0; lk<6; lk++){
      var lt = lk/5;
      var lx = cx-20 + 14*lt, ly = by-8 + 10*lt;
      pxEllipse(ctx, lx, ly, 2, 1, pal.goldDk);
      pxRect(ctx, Math.round(lx), Math.round(ly), 1, 1, pal.goldHi);
      pxEllipse(ctx, cx+20-14*lt, ly, 2, 1, pal.goldDk);
      pxRect(ctx, Math.round(cx+20-14*lt), Math.round(ly), 1, 1, pal.goldHi);
    }
    /* tier 3 — the gem: elongated vertical rhombus, gold frame, sunburst halo,
       red body, white-hot vertical slit that flares on runeFlare */
    var gy2 = by+2;
    ctx.globalAlpha = pulse*0.35;
    pxDiamond(ctx, cx, gy2, 12*throb, 15*throb, pal.gemHalo);
    ctx.globalAlpha = 1;
    for (var sb=0; sb<8; sb++){
      var ang = sb*(Math.PI/4) + Math.PI/8;
      var sx0 = cx + Math.cos(ang)*9, sy0 = gy2 + Math.sin(ang)*12;
      var sx1 = cx + Math.cos(ang)*14, sy1 = gy2 + Math.sin(ang)*18;
      pxLine(ctx, sx0, sy0, sx1, sy1, 1, pal.gold);
      pxRect(ctx, Math.round(sx1), Math.round(sy1), 1, 1, pal.goldHi);
    }
    pxDiamond(ctx, cx, gy2, 9*throb, 12*throb, pal.gold);
    pxDiamond(ctx, cx, gy2, 8*throb, 11*throb, "#e01a0a");
    ctx.globalAlpha = pulse;
    pxRect(ctx, cx-1, Math.round(gy2-7*throb), 2, Math.round(14*throb), pal.gemCore);
    pxRect(ctx, cx, Math.round(gy2-2), 1, 4, "#ffffff");
    ctx.globalAlpha = 1;
    /* tier 4 — lower chevron plate ending in a point, with side flanges */
    pxLine(ctx, cx-14, by+8, cx, by+22, 3, pal.goldDk);
    pxLine(ctx, cx+14, by+8, cx, by+22, 3, pal.goldDk);
    pxLine(ctx, cx-14, by+8, cx, by+22, 2, pal.gold);
    pxLine(ctx, cx+14, by+8, cx, by+22, 2, pal.gold);
    pxLine(ctx, cx-13, by+9, cx, by+21, 1, pal.goldHi);
    pxLine(ctx, cx+13, by+9, cx, by+21, 1, pal.goldHi);
    pxTri(ctx, cx, by+26, cx-3, by+20, cx+3, by+20, pal.gold);
    pxRect(ctx, cx, by+22, 1, 3, pal.goldHi);
    pxTri(ctx, cx-16, by+10, cx-22, by+8, cx-16, by+14, pal.gold);
    pxTri(ctx, cx-15, by+15, cx-21, by+13, cx-15, by+19, pal.gold);
    pxTri(ctx, cx+16, by+10, cx+22, by+8, cx+16, by+14, pal.gold);
    pxTri(ctx, cx+15, by+15, cx+21, by+13, cx+15, by+19, pal.gold);
    /* shoulder anchor studs */
    pxDiamond(ctx, cx-20, by-8, 3, 3, pal.gold);
    pxDiamond(ctx, cx+20, by-8, 3, 3, pal.gold);
    pxRect(ctx, cx-20, by-8, 1, 1, pal.goldHi);
    pxRect(ctx, cx+20, by-8, 1, 1, pal.goldHi);
  }

  /* ── forelimb: massive planted limb, 4 separated digits, 3-tone curved claws ── */
  function omegaBracer(ctx, x, y, pal) {
    pxEllipse(ctx, x, y, 8, 4, pal.outline);
    pxEllipse(ctx, x, y, 7, 3, pal.goldDk);
    pxEllipse(ctx, x, y, 6, 2, pal.gold);
    pxRect(ctx, x-4, y-1, 8, 1, pal.goldHi);
    pxTri(ctx, x-5, y-2, x-7, y-8, x-2, y-3, pal.gold);
    pxTri(ctx, x+5, y-2, x+7, y-8, x+2, y-3, pal.gold);
    pxTri(ctx, x-4, y+2, x-6, y+7, x-1, y+3, pal.goldDk);
    pxTri(ctx, x+4, y+2, x+6, y+7, x+1, y+3, pal.goldDk);
    pxRect(ctx, x-7, y-8, 1, 2, pal.goldHi);
    pxRect(ctx, x+7, y-8, 1, 2, pal.goldHi);
  }
  function omegaForelimb(ctx, sx, sy, dir, flick, pal, flex) {
    var curl = (flex||0)*1.4;
    /* boulder deltoid with gold rim-light along the outer edge */
    pxEllipse(ctx, sx, sy, 11, 9, pal.outline);
    pxEllipse(ctx, sx, sy, 10, 8, pal.furMid);
    pxEllipse(ctx, sx - dir*3, sy-3, 5, 3, pal.furLight);
    pxLine(ctx, sx - dir*9, sy-4, sx - dir*9, sy+4, 1, pal.goldDk);
    pxLine(ctx, sx - dir*8, sy-5, sx - dir*8, sy+3, 1, pal.gold);
    /* forearm down to the paw, two gold chevron inlay bands */
    var ax = sx + dir*6;
    pxLine(ctx, sx+dir*2, sy+6, ax, sy+26, 9, pal.furDark);
    pxLine(ctx, sx+dir*2, sy+6, ax, sy+26, 7, pal.furMid);
    pxLine(ctx, ax-dir*4, sy+13, ax, sy+16, 1, pal.gold);
    pxLine(ctx, ax+dir*4, sy+13, ax, sy+16, 1, pal.gold);
    pxLine(ctx, ax-dir*4, sy+19, ax, sy+22, 1, pal.goldDk);
    pxLine(ctx, ax+dir*4, sy+19, ax, sy+22, 1, pal.goldDk);
    omegaBracer(ctx, ax, sy+26, pal);
    /* broad planted paw */
    var py = sy+32;
    pxEllipse(ctx, ax, py, 12, 5, pal.outline);
    pxEllipse(ctx, ax, py, 11, 4, pal.furDark);
    pxEllipse(ctx, ax, py-1, 8, 2, pal.furMid);
    /* 4 separated digits with knuckle bulges + visible gaps, each ending in a
       long curved claw rendered dark base -> gold body -> white tip */
    for (var d=0; d<4; d++){
      var dx = ax - 9 + d*6;
      pxEllipse(ctx, dx, py+2, 2.4, 3, pal.furMid);
      pxEllipse(ctx, dx, py, 2, 1.6, pal.furLight);
      var clawLen = 14;
      var cx0 = dx, cy0 = py+4;
      var cx1 = dx + dir*2 + curl*dir, cy1 = cy0 + clawLen*0.55;
      var cx2 = dx + dir*3 + curl*1.6*dir, cy2 = cy0 + clawLen;
      pxLine(ctx, cx0, cy0, cx1, cy1, 3, pal.goldDk);
      pxLine(ctx, cx0, cy0, cx1, cy1, 2, pal.claw);
      pxLine(ctx, cx1, cy1, cx2, cy2, 2, pal.claw);
      pxLine(ctx, cx1, cy1, cx2, cy2, 1, pal.clawHi);
      pxRect(ctx, Math.round(cx2), Math.round(cy2), 1, 2, "#fff4d0");
    }
  }

  /* ── head: heraldic Cerberus head — flame-spike crest (7+, varied, flickering),
        full upper + lower fang rows, heavy brow ridge, faceted muzzle.
        dir=-1 left / 0 center (frontal) / +1 right. jaw adds extra gape. ── */
  function omegaHead(ctx, cx, cy, o, pal) {
    var dir = o.dir||0, s = o.size||1, roar = o.roar||false, blink = o.blink||0;
    var gx = o.gazeX||0, gy = o.gazeY||0, jaw = o.jaw||0, crestFlick = o.crestFlick||0;
    var hw = Math.round(11*s), hh = Math.round(10*s);
    var snoutX = dir * Math.round(5*s);
    pxEllipse(ctx, cx, cy, hw+1, hh+1, pal.outline);
    /* ears — swept-back, gold inner inlay */
    var earH = Math.round(8*s);
    pxTri(ctx, cx-hw+1, cy-hh+2, cx-hw-3, cy-hh-earH, cx-hw+6, cy-hh, pal.furDark);
    pxTri(ctx, cx+hw-1, cy-hh+2, cx+hw+3, cy-hh-earH, cx+hw-6, cy-hh, pal.furDark);
    pxLine(ctx, cx-hw+1, cy-hh+2, cx-hw-3, cy-hh-earH, 1, pal.gold);
    pxLine(ctx, cx+hw-1, cy-hh+2, cx+hw+3, cy-hh-earH, 1, pal.gold);
    pxEllipse(ctx, cx, cy, hw, hh, pal.furMid);
    /* subtle rounded skull highlight — NOT a flat band (that read as a crown);
       the flame mane below rises from the skull top */
    pxEllipse(ctx, cx, cy-hh+4, hw-5, 2, pal.furLight);
    /* cheek lava veins */
    pxLine(ctx, cx-Math.round(hw*0.7), cy+1, cx-Math.round(hw*0.35), cy+4, 1, pal.lava3);
    pxLine(ctx, cx+Math.round(hw*0.7), cy+1, cx+Math.round(hw*0.35), cy+4, 1, pal.lava3);
    pxRect(ctx, cx-Math.round(hw*0.35), cy+4, 1,1, pal.lava5);
    pxRect(ctx, cx+Math.round(hw*0.35), cy+4, 1,1, pal.lava5);
    /* crest — a feral mane of sinuous flame tongues (reuses flameTongueSin),
       not a gold crown: fire-colored, varied heights, tips breaking the
       silhouette and whipping on independent phases. Center head keeps its
       gold scimitar horns + diamond on top (drawn below). */
    var spikes = 9;
    var baseY = cy - hh + 2;
    for (var k=0; k<spikes; k++){
      var u = (k/(spikes-1)) - 0.5;
      var baseX = cx + Math.round(u*hw*1.8);
      var centerBoost = 1 + 0.8*Math.cos(u*Math.PI);
      var hgt = Math.round((7 + 7*Math.abs(Math.sin(k*2.1+0.5))) * s * centerBoost);
      hgt = Math.max(5, hgt);
      flameTongueSin(ctx, baseX, baseY, hgt, 5, 3.5, k*0.8, crestFlick*(0.24+(k%3)*0.08), k*5, pal);
    }
    /* outer mane flames leaning hard outward for a feral silhouette */
    flameTongueSin(ctx, cx-hw-2, baseY+1, Math.round(7*s), 4, 3.0, 4.4, crestFlick*0.22, 31, pal);
    flameTongueSin(ctx, cx+hw+2, baseY+1, Math.round(7*s), 4, 3.0, 1.2, crestFlick*0.22, 47, pal);
    /* short tufts at the very edges */
    flameTongueSin(ctx, cx-hw-4, baseY+3, Math.round(4*s), 3, 2.0, 2.8, crestFlick*0.26, 53, pal);
    flameTongueSin(ctx, cx+hw+4, baseY+3, Math.round(4*s), 3, 2.0, 5.1, crestFlick*0.26, 61, pal);
    if (dir === 0) {
      /* center head: two long curved scimitar horns + forehead diamond emblem */
      var hornH = Math.round(14*s);
      pxLine(ctx, cx-hw+2, cy-hh+1, cx-hw-6, cy-hh-hornH*0.5, 3, pal.gold);
      pxLine(ctx, cx-hw-6, cy-hh-hornH*0.5, cx-hw-12, cy-hh-hornH, 2, pal.gold);
      pxRect(ctx, cx-hw-12, cy-hh-hornH, 1, 2, pal.goldHi);
      pxLine(ctx, cx+hw-2, cy-hh+1, cx+hw+6, cy-hh-hornH*0.5, 3, pal.gold);
      pxLine(ctx, cx+hw+6, cy-hh-hornH*0.5, cx+hw+12, cy-hh-hornH, 2, pal.gold);
      pxRect(ctx, cx+hw+12, cy-hh-hornH, 1, 2, pal.goldHi);
      var fy = cy-hh+5;
      pxDiamond(ctx, cx, fy, 4, 5, pal.outline);
      pxDiamond(ctx, cx, fy, 3, 4, pal.gold);
      pxDiamond(ctx, cx, fy, 2, 3, pal.gem);
      pxRect(ctx, cx, fy-1, 1, 2, pal.gemCore);
    } else {
      pxLine(ctx, cx+dir*2, cy-hh+5, cx+dir*(hw-2), cy-hh+8, 1, pal.gold);
    }
    /* brow ridges — heavy dark ridges casting the eyes into shadow, meeting at
       the nose bridge in an angry V, with a thin lava top-highlight */
    var ey = cy-2;
    pxLine(ctx, cx-Math.round(hw*0.75), ey-3, cx-2, ey-1, 2, pal.furDeep);
    pxLine(ctx, cx+Math.round(hw*0.75), ey-3, cx+2, ey-1, 2, pal.furDeep);
    pxLine(ctx, cx-Math.round(hw*0.7), ey-4, cx-2, ey-2, 1, pal.lava2);
    pxLine(ctx, cx+Math.round(hw*0.7), ey-4, cx+2, ey-2, 1, pal.lava2);
    /* eyes — hot-white core under an orange bloom, set beneath the brows */
    var exL = cx-6 + (dir<0?1:0), exR = cx+3 + (dir>0?-1:0);
    if (blink > 0.9) {
      pxRect(ctx, exL, ey+1, 4, 1, pal.outline);
      pxRect(ctx, exR, ey+1, 4, 1, pal.outline);
    } else {
      pxRect(ctx, exL+gx-1, ey+gy-1, 5, 3, pal.eye);
      pxRect(ctx, exL+gx, ey+gy, 3, 1, pal.eyeCore);
      pxRect(ctx, exL+gx+1, ey+gy, 1, 1, "#ffffff");
      pxRect(ctx, exR+gx-1, ey+gy-1, 5, 3, pal.eye);
      pxRect(ctx, exR+gx, ey+gy, 3, 1, pal.eyeCore);
      pxRect(ctx, exR+gx+1, ey+gy, 1, 1, "#ffffff");
    }
    /* muzzle — nose-bridge plane with a lighter top facet + dark side facets */
    var mx = cx + snoutX;
    pxEllipse(ctx, mx, cy+3, 5, 4, pal.furLight);
    pxEllipse(ctx, mx, cy+2, 4, 2, pal.furHi);
    pxRect(ctx, mx-4, cy+3, 2, 3, pal.furDark);
    pxRect(ctx, mx+3, cy+3, 2, 3, pal.furDark);
    /* center head: nose on the bridge; side heads: a protruding snout mass so
       they read as wolves in 3/4, not flat masks with a fang slot */
    if (dir === 0) {
      pxRect(ctx, mx - 1, cy+2, 3, 2, pal.nose);
      pxRect(ctx, mx - 1, cy+2, 1, 1, "#000000");
      pxRect(ctx, mx + 1, cy+2, 1, 1, "#000000");
    } else {
      /* side head: a LIGHTER, projecting muzzle that breaks the head silhouette
         so it reads as a wolf in 3/4, not a flat mask. Three cues: value contrast
         (light muzzle on dark skull), silhouette break (projects past the cheek),
         and a defined dark nose tip. */
      var sx2 = mx + dir*7;                                  /* muzzle projects well past the cheek */
      pxEllipse(ctx, sx2, cy+3, 7, 5, pal.outline);          /* outline breaks the silhouette */
      pxEllipse(ctx, sx2, cy+3, 6, 4, pal.furLight);         /* LIGHTER muzzle patch */
      pxEllipse(ctx, sx2, cy+2, 5, 2, pal.furHi);            /* lit bridge */
      /* warm rim-light along the muzzle (fire from below) */
      pxLine(ctx, sx2 - dir*4, cy+1, sx2 + dir*4, cy+1, 1, pal.lava2);
      /* defined nose tip at the very end */
      pxRect(ctx, sx2 + dir*6 - 1, cy+2, 3, 3, pal.nose);
      pxRect(ctx, sx2 + dir*6 - 1, cy+2, 1, 1, "#000000");
      pxRect(ctx, sx2 + dir*6 + 1, cy+2, 1, 1, "#000000");
      /* heavy brow ridge over the muzzle, casting the eye into shadow */
      pxLine(ctx, sx2 - dir*8, cy-1, sx2 + dir*2, cy, 2, pal.furDeep);
      pxLine(ctx, sx2 - dir*7, cy-2, sx2 + dir*2, cy-1, 1, pal.lava2);
    }
    /* jaw + fangs — full upper and lower rows, interlocking, canines longer.
       jaw adds extra gape for chatter / roar. */
    var gape = (roar?6:2) + jaw;
    var my = cy+4;
    pxEllipse(ctx, mx, my+gape/2, 7, gape/2+1, pal.mouth);
    if (gape > 3) {
      pxEllipse(ctx, mx, my+gape/2+1, 5, Math.max(1,gape/2-1), pal.tongue);
      pxRect(ctx, mx-1, my+1, 2, Math.max(1,Math.round(gape-1)), pal.flameOrg);
    }
    var teethU = 6;
    for (var tu=0; tu<teethU; tu++){
      var tx = mx-6 + tu*2.4;
      var isCanine = (tu===0 || tu===teethU-1);
      var tlen = isCanine? 5 : 3;
      pxTri(ctx, Math.round(tx), my, Math.round(tx)+1, my+tlen, Math.round(tx)+2, my, pal.fang);
      if (isCanine) pxRect(ctx, Math.round(tx)+1, my+1, 1, 1, "#ffffff");
    }
    var teethL = 5, lowY = my+Math.round(gape);
    for (var tl=0; tl<teethL; tl++){
      var tx2 = mx-5 + tl*2.4;
      var isCanine2 = (tl===0 || tl===teethL-1);
      var tlen2 = isCanine2? 4 : 2;
      pxTri(ctx, Math.round(tx2), lowY, Math.round(tx2)+1, lowY-tlen2, Math.round(tx2)+2, lowY, pal.fang);
    }
    /* chin / lower jaw mass */
    pxEllipse(ctx, mx, lowY+2, 6, 3, pal.furDark);
    pxEllipse(ctx, mx, lowY+1, 4, 1, pal.furMid);
  }

  function omegaTail(ctx, x0, y0, wag, flick, flameI, pal, dir) {
    /* hip tail, 4 gold dorsal barbs + flared flame-barb tip (side view only). */
    dir = dir==null?1:dir;
    pxLine(ctx, x0, y0, x0+7*dir, y0+2, 4, pal.furDark);
    pxLine(ctx, x0+7*dir, y0+2, x0+6*dir+wag*0.3*dir, y0-6, 4, pal.furDark);
    pxLine(ctx, x0+6*dir+wag*0.3*dir, y0-6, x0+12*dir+wag*dir, y0-11, 4, pal.furDark);
    for (var b=0;b<4;b++){
      var bt=b/3;
      var bx=x0+7*dir+ (12*dir+wag*dir-7*dir)*bt*0.9;
      var by=y0+2 + (y0-11-(y0+2))*bt;
      pxTri(ctx, bx, by-3, bx-2, by+1, bx+2, by+1, pal.gold);
    }
    var tx=x0+12*dir+wag*dir, ty=y0-11;
    pxTri(ctx, tx, ty-5, tx-3, ty+1, tx+1, ty, pal.gold);
    pxTri(ctx, tx+1*dir, ty-3, tx+4*dir, ty-5, tx+3*dir, ty, pal.gold);
    pxTri(ctx, tx-1*dir, ty-3, tx-4*dir, ty-5, tx-3*dir, ty, pal.gold);
    flameTongue(ctx, tx, ty-3, 6*flameI, 3, wag*0.5*dir, 7, pal);
  }
  function omegaVeins(ctx, cx, cy, flick, pal) {
    /* molten ember veins beneath the obsidian hide — a network of glowing lava
       cracks so the beast reads as cooled volcanic rock with fire underneath. */
    var pulse = 0.7 + 0.3*Math.sin(flick*0.1);
    var veins = [
      [cx-26,cy-2, cx-19,cy+2, cx-13,cy+6],
      [cx+26,cy-2, cx+19,cy+2, cx+13,cy+6],
      [cx-22,cy+6, cx-16,cy+9, cx-9,cy+10],
      [cx+22,cy+6, cx+16,cy+9, cx+9,cy+10],
      [cx-7,cy+9, cx,cy+11, cx+7,cy+9],
      [cx-16,cy-8, cx-10,cy-5, cx-5,cy-7],
      [cx+16,cy-8, cx+10,cy-5, cx+5,cy-7],
      [cx-28,cy-6, cx-24,cy-1, cx-20,cy-4],
      [cx+28,cy-6, cx+24,cy-1, cx+20,cy-4],
      [cx-14,cy-12, cx-9,cy-9, cx-4,cy-11],
      [cx+14,cy-12, cx+9,cy-9, cx+4,cy-11]
    ];
    for (var v=0; v<veins.length; v++) {
      var vn = veins[v];
      for (var sgm=0; sgm<vn.length-2; sgm+=2) {
        pxLine(ctx, vn[sgm], vn[sgm+1], vn[sgm+2], vn[sgm+3], 3, pal.lava2);
        pxLine(ctx, vn[sgm], vn[sgm+1], vn[sgm+2], vn[sgm+3], 2, pal.lava3);
        pxLine(ctx, vn[sgm], vn[sgm+1], vn[sgm+2], vn[sgm+3], 1, pal.lava5);
      }
    }
    ctx.globalAlpha = pulse;
    var nodes = [[cx-19,cy+2],[cx+19,cy+2],[cx-13,cy+6],[cx+13,cy+6],[cx,cy+11],
                 [cx-10,cy-5],[cx+10,cy-5],[cx-16,cy+9],[cx+16,cy+9],
                 [cx-24,cy-1],[cx+24,cy-1],[cx-9,cy-9],[cx+9,cy-9]];
    for (var n=0; n<nodes.length; n++) {
      pxRect(ctx, nodes[n][0], nodes[n][1], 1, 1, n%3===0 ? pal.lava5 : pal.lava4);
    }
    ctx.globalAlpha = 1;
  }

  /* ── neck: tapered muscular column with scale texture + warm rim-light ──
     Drawn from the shoulder (bx,by, wide) to the head base (tx,ty, narrow).
     Dark seams + a warm under-rim every few rows so it reads as layered hide,
     not a smooth tube; edges catch the lava backlight. */
  function omegaNeck(ctx, bx, by, tx, ty, bw, tw, flick, pal) {
    var steps = 16;
    for (var i=0; i<=steps; i++) {
      var t = i/steps;
      var x = Math.round(bx + (tx-bx)*t);
      var y = Math.round(by + (ty-by)*t);
      var w = Math.round(bw + (tw-bw)*t);   /* tapers toward the head */
      var half = Math.floor(w/2);
      pxLine(ctx, x-half, y, x+half, y, 1, pal.furDark);
      if (w > 5) pxRect(ctx, x-1, y, 2, 1, pal.furMid);   /* throat plane */
      /* scale seam + warm under-rim every few rows */
      if (i % 3 === 2 && i < steps) {
        pxLine(ctx, x-half, y, x+half, y, 1, pal.furDeep);
        if (w > 4) pxLine(ctx, x-half+1, y+1, x+half-1, y+1, 1, pal.lava3);
      }
    }
    /* warm rim-light on both edges (lava backlight) */
    pxLine(ctx, bx-Math.floor(bw/2), by, tx-Math.floor(tw/2), ty, 1, pal.lava2);
    pxLine(ctx, bx+Math.floor(bw/2), by, tx+Math.floor(tw/2), ty, 1, pal.lava2);
  }

  /* ── OMEGA skeletal sprite layer ───────────────────────────────────────
     The v2 Cerberus pixel art is cut into four layers at real anatomical
     joints: a body anchor plus three heads, each with a deep neck stub.
     Every head ROTATES around a pivot at the base of its neck (true joint
     rotation, not a column-shear of one raster), the body breathes with a
     vertical scale anchored at the paws so the beast never hovers, and the
     procedural fire wall / lava crust / ember veins still draw on top for
     continuous life between keyframes. The body carries an inpainted dark
     neck stump under each head, so a few degrees of rotation reveals fur,
     never a hole.
     Pipeline: ~/cerb-sprite-v2/process_skel.py — re-run if the art changes. */
  /* Skeletal layers v4: heads carry their own neck pixels; body is erased
     under the heads with a feathered bottom edge. No inpainting needed.
     Pipeline: ~/cerb-sprite-v2/process_skel.py */
  var OMEGA_SKEL = {
    body: {
      src: "data:image/png;base64,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",
      box: [0,0,160,160], pivot: [80,80]
    },
    headL: {
      src: "data:image/png;base64,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",
      box: [0,0,66,90], pivot: [46,82]
    },
    headC: {
      src: "data:image/png;base64,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",
      box: [44,0,116,90], pivot: [80,84]
    },
    headR: {
      src: "data:image/png;base64,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",
      box: [94,0,160,90], pivot: [114,82]
    },
  };

  /* Decoded layer canvases (null until the PNGs finish loading). */
  var skelReady = false, skelPending = 0;
  var skelBody = null, skelHeadL = null, skelHeadC = null, skelHeadR = null;
  var skelAlphaBody = null, skelAlphaHeadL = null, skelAlphaHeadC = null, skelAlphaHeadR = null;

  /* Recolour a layer canvas into ALPHA's ascended white-gold plasma. Same
     gamma ramp the old single-sprite build used: shadows lift to warm bone,
     veins/flame blow out to white-hot, plate contrast preserved. */
  function skelRecolor(src) {
    try {
      var c = document.createElement("canvas");
      c.width = src.width; c.height = src.height;
      var g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(src, 0, 0);
      var id = g.getImageData(0, 0, c.width, c.height), d = id.data;
      for (var i = 0; i < d.length; i += 4) {
        if (d[i+3] === 0) continue;
        var r = d[i], gg = d[i+1], b = d[i+2];
        var L = (r * 0.36 + gg * 0.5 + b * 0.14) / 255;
        var nr, ng, nb;
        if (L < 0.55) { var t = Math.pow(L / 0.55, 1.35);
          nr = 14 + t * 196; ng = 9 + t * 150; nb = 4 + t * 58;
        } else { var u = (L - 0.55) / 0.45;
          nr = 210 + u * 45; ng = 159 + u * 96; nb = 62 + u * 193; }
        d[i]   = nr > 255 ? 255 : nr;
        d[i+1] = ng > 255 ? 255 : ng;
        d[i+2] = nb > 255 ? 255 : nb;
      }
      g.putImageData(id, 0, 0);
      return c;
    } catch (e) { return null; }
  }

  function skelLoaded() {
    if (--skelPending === 0) {
      skelAlphaBody  = skelRecolor(skelBody);
      skelAlphaHeadL = skelRecolor(skelHeadL);
      skelAlphaHeadC = skelRecolor(skelHeadC);
      skelAlphaHeadR = skelRecolor(skelHeadR);
      skelReady = true;
    }
  }
  function skelLoad(name, assign) {
    var im = new Image();
    skelPending++;
    im.onload = function () {
      var c = document.createElement("canvas");
      c.width = im.width; c.height = im.height;
      var g = c.getContext("2d");
      g.imageSmoothingEnabled = false;
      g.drawImage(im, 0, 0);
      assign(c);
      skelLoaded();
    };
    im.src = OMEGA_SKEL[name].src;
  }
  skelLoad("body",  function (c) { skelBody  = c; });
  skelLoad("headL", function (c) { skelHeadL = c; });
  skelLoad("headC", function (c) { skelHeadC = c; });
  skelLoad("headR", function (c) { skelHeadR = c; });

  /* Draw one skeletal layer with a 2D transform about an arbitrary pivot.
     box is the layer's crop rect in sprite space; (px,py) is the joint the
     transform pivots on; rot is radians; sx/sy scale; dx/dy translate. */
  function skelDraw(ctx, layer, box, px, py, rot, sx, sy, dx, dy) {
    if (!layer) return;
    ctx.save();
    ctx.translate(px + dx, py + dy);
    if (rot) ctx.rotate(rot);
    if (sx !== 1 || sy !== 1) ctx.scale(sx, sy);
    ctx.drawImage(layer, box[0] - px, box[1] - py);
    ctx.restore();
  }

  /* Returns false until the layers decode so the caller can fall back to the
     procedural rig for the first frame or two. */
  function drawOmegaSprite(ctx, P, useAlpha) {
    if (!skelReady) return false;
    var t   = P.flick || 0;
    var amp = reduced ? 0 : 1;                       /* honour reduced-motion */
    if (useAlpha) { t *= 1.35; amp *= 1.4; }         /* ALPHA is more agitated */
    var bob = (P.bob || 0) * amp;
    var gx  = (P.gazeX || 0), gy = (P.gazeY || 0);
    var sad = P.sad || 0, droop = sad * 3, howl = P.howl || 0, headLift = howl * 8;
    var hl = P.headL || 0, hr = P.headR || 0, hc = P.headC || 0;

    ctx.imageSmoothingEnabled = false;

    var body = (useAlpha && skelAlphaBody)  ? skelAlphaBody  : skelBody;
    var hL   = (useAlpha && skelAlphaHeadL) ? skelAlphaHeadL : skelHeadL;
    var hC   = (useAlpha && skelAlphaHeadC) ? skelAlphaHeadC : skelHeadC;
    var hR   = (useAlpha && skelAlphaHeadR) ? skelAlphaHeadR : skelHeadR;

    /* Breathing: vertical scale about a pivot at the paws (y=152) so the chest
       rises but the feet stay planted. A touch of shoulder roll on top. */
    var breathe = Math.sin(t * 0.09) * amp;
    var bodySy  = 1 + breathe * 0.016;
    var bodyDy  = breathe * 0.6;

    /* Head joint rotations (radians) on independent phases, plus gaze lead.
       Side heads swing wider; the big centre head is steadier. */
    var rotL = Math.sin(t * 0.043 + 1.0) * 0.085 * amp + gx * 0.035;
    var rotC = Math.sin(t * 0.030 + 5.0) * 0.050 * amp + gx * 0.020;
    var rotR = Math.sin(t * 0.037 + 3.0) * 0.085 * amp + gx * 0.035;
    /* Nod = vertical bob of each head about its own phase, plus gaze/sadness. */
    var nodL = Math.sin(t * 0.110 + 0.4) * 1.5 * amp + gy * 0.8 + droop - headLift;
    var nodC = Math.sin(t * 0.070)       * 1.0 * amp + gy * 0.6 + droop * 0.5 - headLift;
    var nodR = Math.sin(t * 0.090 + 2.1) * 1.5 * amp + gy * 0.8 + droop - headLift;

    /* Draw order: body anchor, side heads, centre head on top. */
    skelDraw(ctx, body, OMEGA_SKEL.body.box,  80, 152, 0,    1, bodySy, 0, bodyDy + bob);
    skelDraw(ctx, hL,   OMEGA_SKEL.headL.box, 46, 82,  rotL, 1, 1, hl + gx * 1.5, nodL + bob * 0.8);
    skelDraw(ctx, hR,   OMEGA_SKEL.headR.box, 114, 82, rotR, 1, 1, hr + gx * 1.5, nodR + bob * 0.8);
    skelDraw(ctx, hC,   OMEGA_SKEL.headC.box, 80, 84,  rotC, 1, 1, hc + gx * 1.2, nodC + bob);
    return true;
  }

  function drawOmegaFront(ctx, P, isAlpha) {
    var W=160,H=160; ctx.clearRect(0,0,W,H);
    var pal=isAlpha?PAL5:PAL4, bob=P.bob||0, flameI=P.flameI==null?1:P.flameI, flick=P.flick||0;
    var gx=P.gazeX||0, gy=P.gazeY||0, sad=P.sad||0, droop=sad*3, howl=P.howl||0;
    var hl=P.headL||0, hr=P.headR||0, hc=P.headC||0, headLift=howl*8;
    /* per-part idle phases — all independent, all derived from flick */
    var breathe = reduced?0:Math.sin(flick*0.09)*2;
    var shoulderB = reduced?0:Math.sin(flick*0.09+0.8)*1;
    var clawFlex = reduced?0:(0.5+0.5*Math.sin(flick*0.06));
    var jawChatter = reduced?0:Math.max(0, Math.sin(flick*0.5))*1.5;
    var yawL = reduced?0:Math.sin(flick*0.043+1)*1.5;
    var yawR = reduced?0:Math.sin(flick*0.037+3)*1.5;
    var yawC = reduced?0:Math.sin(flick*0.03+5)*0.8;
    var blinkL = ((flick+40)%130<4)?1:0;
    var blinkR = ((flick+85)%150<4)?1:0;
    var blinkC = P.blink||0;

    omegaFlameWall(ctx, W, H, flick, pal, flameI);
    omegaLavaCrust(ctx, W, H, flick, pal);

    /* paw grounding shadow — drawn BEHIND the sprite so the bright lava in the
       gaps between claws is darkened and the talons read against darkness.
       The claws themselves (part of the sprite) stay on top. */
    pxEllipse(ctx, 40, 150, 17, 6, pal.outline);
    pxEllipse(ctx, 118, 150, 17, 6, pal.outline);

    /* Baked sprite driven by the column-shear rig (drawOmegaSprite): keeps the
       high-fidelity pixel art AND animates it per-part -- heads sway/nod on
       independent phases, chest breathes, paws stay pinned. Falls back to the
       procedural rig for the frame or two before the PNG decodes. */
    if (!drawOmegaSprite(ctx, P, isAlpha)) {

    /* torso — broad inverted trapezoid, chest out, cropped at the forelimbs */
    pxEllipse(ctx, 80, 108+breathe*0.5, 44, 26, pal.furDark);
    pxEllipse(ctx, 80, 100+breathe*0.5, 36, 24, pal.furMid);
    pxEllipse(ctx, 80, 92+breathe*0.5, 26, 16, pal.furLight);
    /* warm inner glow — the chest radiates heat from within, so the hide reads
       as cracked-over-molten-rock rather than a flat dark blob */
    ctx.globalAlpha = 0.16 + 0.05*Math.sin(flick*0.1);
    pxEllipse(ctx, 80, 100+breathe*0.5, 30, 20, pal.gemHalo);
    ctx.globalAlpha = 0.10;
    pxEllipse(ctx, 80, 102+breathe*0.5, 20, 13, pal.lava2);
    ctx.globalAlpha = 1;
    /* two distinct pec masses flanking the chest gem — each lobe catches light
       on its top face (furLight + furHi rim) so the chest reads as stacked
       muscle catching firelight, not one flat dark mass */
    pxEllipse(ctx, 62, 101+breathe, 14, 12, pal.furMid);
    pxEllipse(ctx, 98, 101+breathe, 14, 12, pal.furMid);
    pxEllipse(ctx, 60, 96+breathe, 9, 6, pal.furLight);
    pxEllipse(ctx, 100, 96+breathe, 9, 6, pal.furLight);
    pxEllipse(ctx, 58, 94+breathe, 5, 3, pal.furHi);
    pxEllipse(ctx, 102, 94+breathe, 5, 3, pal.furHi);
    /* shoulder/deltoid masses capping the forelimbs, lit from the lava below */
    pxEllipse(ctx, 46, 97+shoulderB, 10, 9, pal.furMid);
    pxEllipse(ctx, 114, 97+shoulderB, 10, 9, pal.furMid);
    pxEllipse(ctx, 44, 94+shoulderB, 6, 4, pal.furLight);
    pxEllipse(ctx, 116, 94+shoulderB, 6, 4, pal.furLight);
    omegaVeins(ctx, 80, 104+breathe*0.5, flick, pal);

    /* forelimbs — massive, planted, angled outward */
    omegaForelimb(ctx, 46, 104+shoulderB, -1, flick, pal, clawFlex);
    omegaForelimb(ctx, 114, 104+shoulderB, 1, flick, pal, clawFlex);

    /* necks — tapered columns fanning up to the three heads, with scale texture
       and warm rim-light so they read as muscular hide, not smooth tubes */
    omegaNeck(ctx, 62, 96+breathe*0.5, 48+hl+yawL, 66+bob*0.8+droop-headLift, 12, 7, flick, pal);
    omegaNeck(ctx, 80, 94+breathe*0.5, 80+hc+yawC, 54+bob+droop*0.5-headLift, 14, 8, flick, pal);
    omegaNeck(ctx, 98, 96+breathe*0.5, 112+hr+yawR, 66+bob*0.8+droop-headLift, 12, 7, flick, pal);

    /* sculpted scale plates across the shoulders + upper chest — drawn AFTER
       the necks so they sit on top and read as separate layered shapes */
    omegaScales(ctx, 80, 84+breathe*0.5, 7, 3, 12, pal);

    /* ornate breastplate — drawn after the necks so the gem sits in front */
    omegaChestPlate(ctx, 80, 96+breathe*0.5, flick, pal, P.runeFlare, breathe*0.5);

    /* three regal heads — center frontal + largest, sides fanned in 3/4 */
    var hgx=Math.max(-1,Math.min(1,gx)), hgy=Math.max(-1,Math.min(1,gy));
    omegaHead(ctx, 48+hl+yawL, 62+bob*0.8+droop-headLift, {dir:-1,size:1.05,roar:P.roarSide||false,blink:blinkL,gazeX:hgx,gazeY:hgy,jaw:jawChatter,crestFlick:flick}, pal);
    omegaHead(ctx, 80+hc+yawC, 50+bob+droop*0.5-headLift, {dir:0,size:1.3,roar:P.roarCenter!==false,blink:blinkC,gazeX:hgx,gazeY:hgy,jaw:0,crestFlick:flick}, pal);
    omegaHead(ctx, 112+hr+yawR, 62+bob*0.8+droop-headLift, {dir:1,size:1.05,roar:P.roarSide||false,blink:blinkR,gazeX:hgx,gazeY:hgy,jaw:jawChatter,crestFlick:flick}, pal);
    }

    if (P.runeFlare) for (var oi=0;oi<8;oi++){var ang=flick*0.15+oi*(Math.PI*2/8);ctx.fillStyle=oi%2?pal.goldHi:pal.gem;ctx.globalAlpha=0.9;ctx.fillRect(Math.round(80+Math.cos(ang)*52),Math.round(60+Math.sin(ang)*26),2,2);ctx.globalAlpha=1;}
    if (P.fireBreath) drawFireBreath(ctx, 80, 40, 110, 20, P.fireBreath, flick, pal);

    /* ember veins pulse — warm glow on the chest that breathes with the
       fire, so the baked body reads as cracked-over-molten-rock, not flat */
    if (!reduced) {
      ctx.globalAlpha = 0.10 + 0.06*Math.sin(flick*0.1);
      pxEllipse(ctx, 80, 100, 28, 18, pal.lava2);
      ctx.globalAlpha = 0.06 + 0.04*Math.sin(flick*0.13+1);
      pxEllipse(ctx, 80, 96, 18, 12, pal.lava4);
      ctx.globalAlpha = 1;
    }

    /* foreground embers rising from the lava, passing in front of the silhouette
       near the feet (background embers live in omegaFlameWall, behind the body) */
    for (var fe=0; fe<6; fe++){
      var fex = 30 + ((fe*37 + Math.round(flick*0.6)) % 100);
      var fey = 152 - ((fe*29 + Math.round(flick*0.9)) % 26);
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = fe%2?pal.flameYel:pal.flameOrg;
      ctx.fillRect(fex, fey, 1, 1);
    }
    ctx.globalAlpha = 1;
  }

  function drawOmegaSide(ctx, P, isAlpha) {
    var W=160,H=160; ctx.clearRect(0,0,W,H);
    var pal=isAlpha?PAL5:PAL4, bob=P.bob||0, walk=P.walk||0, flameI=P.flameI==null?1:P.flameI, flick=P.flick||0;
    var gx=P.gazeX||0, gy=P.gazeY||0, squash=P.squash||1, sad=P.sad||0, lean=P.lean||0;
    var clawFlex = reduced?0:(0.5+0.5*Math.sin(flick*0.06));
    omegaFlameWall(ctx, W, H, flick, pal, flameI);
    omegaLavaCrust(ctx, W, H, flick, pal);
    var legAmp=walk?10:0; function legSwing(ph){return Math.round(Math.sin(walk+ph)*legAmp);}
    /* far-side legs (behind the body) */
    pxLine(ctx,52+legSwing(Math.PI),104,50+legSwing(Math.PI),132,9,pal.furDark);
    pxRect(ctx,44+legSwing(Math.PI),130,12,4,pal.furDark);
    pxLine(ctx,104+legSwing(0),104,106+legSwing(0),132,9,pal.furDark);
    pxRect(ctx,98+legSwing(0),130,12,4,pal.furDark);
    omegaTail(ctx, 122, 96, Math.sin((P.tailWag||0))*4, flick, flameI, pal, 1);
    /* barrel torso */
    pxEllipse(ctx,80,98+bob*0.3,44*squash,24/squash,pal.furDark);
    pxEllipse(ctx,52,94+bob*0.3,22*squash,20/squash,pal.furMid);
    pxEllipse(ctx,108,94+bob*0.3,20*squash,20/squash,pal.furDark);
    pxEllipse(ctx,76,84+bob*0.3,32,5,pal.furLight);
    omegaScales(ctx, 80, 84+bob*0.3, 5, 2, 11, pal);
    omegaVeins(ctx, 80, 100+bob*0.3, flick, pal);
    /* near-side legs with 3-tone curved claws */
    pxLine(ctx,60+legSwing(0),102,58+legSwing(0),134,10,pal.furMid);
    pxRect(ctx,50+legSwing(0),132,14,4,pal.furMid);
    omegaBracer(ctx, 59+legSwing(0), 122, pal);
    for (var c3=0;c3<4;c3++){
      var dx3=51+legSwing(0)+c3*3.4;
      pxLine(ctx,dx3,136,dx3+1+clawFlex,146,2,pal.claw);
      pxLine(ctx,dx3,136,dx3+1+clawFlex,146,1,pal.clawHi);
    }
    pxLine(ctx,112+legSwing(Math.PI),102,114+legSwing(Math.PI),134,10,pal.furMid);
    pxRect(ctx,104+legSwing(Math.PI),132,14,4,pal.furMid);
    omegaBracer(ctx, 113+legSwing(Math.PI), 122, pal);
    for (var c4=0;c4<4;c4++){
      var dx4=105+legSwing(Math.PI)+c4*3.4;
      pxLine(ctx,dx4,136,dx4+1+clawFlex,146,2,pal.claw);
      pxLine(ctx,dx4,136,dx4+1+clawFlex,146,1,pal.clawHi);
    }
    /* necks + three heads fanned at the front (facing left) */
    var droop=sad*3, nl=-lean;
    pxLine(ctx,34+nl,72+bob*0.8+droop,44,94+bob*0.3,10,pal.furDark);
    pxLine(ctx,52+nl,62+bob+droop*0.5,56,94+bob*0.3,12,pal.furDark);
    pxLine(ctx,70+nl,72+bob*0.8+droop,68,94+bob*0.3,10,pal.furDark);
    var hgx=Math.max(-1,Math.min(1,gx)), hgy=Math.max(-1,Math.min(1,gy));
    omegaHead(ctx,34+nl,66+bob*0.8+droop+(lean?1:0),{dir:-1,size:1.0,roar:P.roarSide||false,blink:P.blink,gazeX:hgx,gazeY:hgy},pal);
    omegaHead(ctx,52+nl,54+bob+droop*0.5+(lean?1:0),{dir:-1,size:1.25,roar:P.roarCenter!==false,blink:P.blink,gazeX:hgx,gazeY:hgy},pal);
    omegaHead(ctx,70+nl,66+bob*0.8+droop+(lean?1:0),{dir:-1,size:1.0,roar:P.roarSide||false,blink:P.blink,gazeX:hgx,gazeY:hgy},pal);
    if (walk) for (var ei=0;ei<6;ei++){var ex=118+((flick*0.8+ei*9)%30),ey=60+((ei*7+flick*0.3)%30);ctx.fillStyle=ei%2?pal.flameOrg:pal.goldHi;ctx.globalAlpha=0.8-(ex-118)/36;ctx.fillRect(Math.round(ex),Math.round(ey),1,1);ctx.globalAlpha=1;}
  }

  /* ── ALPHA — ascended OMEGA ─────────────────────────────────────────────
     Same rig, same baked raster (recoloured), plus an ascension corona: a
     rotating halo of plasma motes and vertical updraft that OMEGA never has,
     so the two forms are unmistakable at a glance even at 1x scale. */
  function alphaCorona(ctx, W, H, flick, pal) {
    if (reduced) return;
    var i, ang, r, x, y;
    /* halo ring orbiting the heads */
    for (i = 0; i < 18; i++) {
      ang = flick * 0.035 + i * (Math.PI * 2 / 18);
      r = 62 + Math.sin(flick * 0.08 + i) * 3;
      x = Math.round(80 + Math.cos(ang) * r);
      y = Math.round(52 + Math.sin(ang) * r * 0.34);
      ctx.globalAlpha = 0.30 + 0.30 * Math.sin(flick * 0.11 + i * 0.7);
      ctx.fillStyle = (i % 3 === 0) ? pal.gemCore : (i % 3 === 1 ? pal.goldHi : pal.gem);
      ctx.fillRect(x, y, 2, 2);
    }
    /* updraft: motes rising off the body, opposite to OMEGA's falling embers */
    for (i = 0; i < 22; i++) {
      var seed = i * 37;
      x = Math.round(24 + ((seed * 7) % 112));
      y = Math.round(150 - ((flick * 1.7 + seed * 3) % 140));
      ctx.globalAlpha = 0.55 * (y / 150);
      ctx.fillStyle = (i % 2) ? pal.flameCore : pal.goldHi;
      ctx.fillRect(x, y, 1, (i % 4 === 0) ? 2 : 1);
    }
    ctx.globalAlpha = 1;
  }

  function drawAlphaFront(ctx, P) {
    drawOmegaFront(ctx, P, true);
    alphaCorona(ctx, 160, 160, P.flick || 0, PAL5);
  }
  function drawAlphaSide(ctx, P) {
    drawOmegaSide(ctx, P, true);
    alphaCorona(ctx, 160, 160, P.flick || 0, PAL5);
  }

  /* ── post-processing ── */
  function applyRim(ctx, W, H, pal) {
    var img = ctx.getImageData(0,0,W,H); var d = img.data;
    function isSolid(x,y){ return x>=0&&y>=0&&x<W&&y<H && d[(y*W+x)*4+3]>0; }
    var rh=parseInt(pal.rimHot.slice(1,3),16), rg=parseInt(pal.rimHot.slice(3,5),16), rb=parseInt(pal.rimHot.slice(5,7),16);
    var nr=parseInt(pal.rim.slice(1,3),16), ng=parseInt(pal.rim.slice(3,5),16), nb=parseInt(pal.rim.slice(5,7),16);
    for (var y=0;y<H;y++) for (var x=0;x<W;x++) {
      var i=(y*W+x)*4; if (d[i+3]===0) continue;
      var edge = !isSolid(x+1,y)||!isSolid(x-1,y)||!isSolid(x,y+1)||!isSolid(x,y-1);
      if (!edge) continue;
      var r=d[i],g=d[i+1],b=d[i+2];
      if (r<120 && g<120 && b<140) {
        if (!isSolid(x,y-1)) { d[i]=rh; d[i+1]=rg; d[i+2]=rb; }
        else { d[i]=nr; d[i+1]=ng; d[i+2]=nb; }
      }
    }
    ctx.putImageData(img,0,0);
  }
  function applyOutline(ctx, W, H, color) {
    var img = ctx.getImageData(0,0,W,H); var d = img.data;
    function isSolid(x,y){ return x>=0&&y>=0&&x<W&&y<H && d[(y*W+x)*4+3]>0; }
    var out = new Uint8ClampedArray(d);
    var or=parseInt(color.slice(1,3),16), og=parseInt(color.slice(3,5),16), ob=parseInt(color.slice(5,7),16);
    for (var y=0;y<H;y++) for (var x=0;x<W;x++) {
      var i=(y*W+x)*4;
      if (d[i+3]===0) {
        var near=false;
        for (var dy=-1;dy<=1&&!near;dy++) for (var dx=-1;dx<=1;dx++) if (isSolid(x+dx,y+dy)){near=true;break;}
        if (near){out[i]=or;out[i+1]=og;out[i+2]=ob;out[i+3]=255;}
      }
    }
    img.data.set(out); ctx.putImageData(img,0,0);
  }
  /* OMEGA-only CRT scanline overlay. source-atop compositing means the
     scanlines only texture the creature's own pixels — they never paint the
     transparent background, so no rectangular canvas edge / box is visible. */
  function applyScanlines(ctx, W, H, res) {
    res = res||1;
    ctx.save();
    ctx.globalCompositeOperation = "source-atop";
    ctx.globalAlpha = 0.09; ctx.fillStyle = "#000000";
    for (var y=0; y<H; y+=3*res) ctx.fillRect(0, y, W, Math.max(1,res));
    ctx.restore();
  }

  var embers = [];
  for (var ei2=0; ei2<8; ei2++) embers.push({x:6+Math.random()*100, y:8+Math.random()*70, vy:0.12+Math.random()*0.22, c:Math.random()});
  function drawEmbers(ctx, t, W, H, res, pal) {
    /* Ember positions live in logical (1×, 112×88) space and are scaled by res
       at draw time, so the ambient drift looks identical at any density. */
    res = res||1;
    for (var i=0;i<embers.length;i++) {
      var e = embers[i];
      e.y -= e.vy; e.x += Math.sin(t.flick*0.1 + e.c*10)*0.18;
      if (e.y < 3) { e.y = 84; e.x = 6+Math.random()*100; }
      var a = Math.min(1, (e.y-3)/16);
      ctx.globalAlpha = a;
      ctx.fillStyle = e.c>0.5 ? pal.flameYel : pal.flameOrg;
      ctx.fillRect(Math.round(e.x*res), Math.round(e.y*res), res, res);
      ctx.globalAlpha = 1;
    }
  }

  /* ── settings (persisted) ── */
  var SETTINGS_KEY = "cerbPetSettings";
  var settings = { enabled:true, scale:3, glow:true, autoEvolve:true, stage:0, xp:0 };
  try {
    var saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (saved) for (var k in settings) if (saved[k] !== undefined) settings[k] = saved[k];
  } catch (e) {}
  if (settings.stage < 0 || settings.stage >= FORMS.length) settings.stage = 0;
  function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {} }

  /* ── canvas element ── */
  var canvas = document.createElement("canvas");
  canvas.id = "cerbPet";
  canvas.style.cssText = "position:fixed;z-index:9999;pointer-events:none;image-rendering:pixelated;image-rendering:crisp-edges;";
  document.body.appendChild(canvas);
  var nctx = canvas.getContext("2d");

  function applyCanvasStyle() {
    var F = FORMS[settings.stage], sc = settings.scale, res = F.res||1;
    /* Internal resolution tracks the form's buffer (res× for HD forms) so the
       display canvas never upsamples the sprite; the CSS size below is what
       sets the on-screen footprint, and it stays at the logical w/h × scale so
       an HD form occupies exactly the same space as before — just crisper. */
    canvas.width = F.w*res; canvas.height = F.h*res;
    canvas.style.width = (F.w*sc) + "px";
    canvas.style.height = (F.h*sc) + "px";
    canvas.style.filter = settings.glow ? "drop-shadow(0 0 6px rgba(224,69,26,0.45)) drop-shadow(0 4px 8px rgba(0,0,0,0.6))" : "none";
    canvas.style.display = settings.enabled ? "block" : "none";
  }
  applyCanvasStyle();

  /* ── always-on evolution HUD ── */
  var hud = document.createElement("div");
  hud.id = "cerbPetHud";
  hud.style.cssText = ["position:fixed","z-index:10000","left:50%","transform:translateX(-50%)","bottom:10px","min-width:250px","padding:6px 12px 7px","border-radius:9px","border:1px solid rgba(224,69,26,0.45)","background:rgba(14,8,8,0.86)","backdrop-filter:blur(6px)","font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace","color:#c9beb0","pointer-events:none","box-shadow:0 4px 18px rgba(0,0,0,0.55)"].join(";") + ";";
  hud.innerHTML =
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;">'
    + '<span id="cerbHudDot" style="width:7px;height:7px;border-radius:50%;background:#6b5a52;flex:none;"></span>'
    + '<span id="cerbHudForm" style="color:#ffd97a;font-weight:700;letter-spacing:0.6px;">PUP</span>'
    + '<span id="cerbHudState" style="color:#8d7e72;">idle</span>'
    + '<span id="cerbHudXP" style="margin-left:auto;color:#e8b84a;">0/100</span>'
    + '</div>'
    + '<div style="height:5px;border-radius:3px;background:#2a1512;overflow:hidden;">'
    + '<div id="cerbHudBar" style="height:100%;width:0%;border-radius:3px;background:linear-gradient(90deg,#e0451a,#ff8a1e,#ffd24a);transition:width .35s ease;"></div>'
    + '</div>';
  document.body.appendChild(hud);

  var HUD_TONE = {
    idle:["#6b5a52","idle"], running:["#ff8a1e","working"], review:["#ffd24a","thinking"],
    waving:["#7ddc7d","done"], jumping:["#7ddc7d","done"], failed:["#e0451a","error"], waiting:["#8d7e72","waiting"]
  };
  var FORM_COLOR = ["#ffd97a", "#fff4d0", "#ff9a2a", "#ffd878", "#fffbe8"];

  function updateHud() {
    if (!hud) return;
    hud.style.display = settings.enabled ? "block" : "none";
    var F = FORMS[settings.stage];
    var maxed = settings.stage >= FORMS.length - 1;
    var pct = maxed ? 100 : Math.max(0, Math.min(100, (settings.xp / F.xpMax) * 100));
    var bar = document.getElementById("cerbHudBar");
    var xpEl = document.getElementById("cerbHudXP");
    var formEl = document.getElementById("cerbHudForm");
    var stEl = document.getElementById("cerbHudState");
    var dot = document.getElementById("cerbHudDot");
    if (bar) {
      bar.style.width = pct + "%";
      bar.style.background = maxed
        ? "linear-gradient(90deg,#d99a3a,#ffd878,#fff4d0,#ffd878)"
        : (settings.stage>=2 ? "linear-gradient(90deg,#ff5a00,#ff9a2a,#ffd84a)" : "linear-gradient(90deg,#e0451a,#ff8a1e,#ffd24a)");
    }
    if (xpEl) xpEl.textContent = maxed ? "MAX" : (Math.floor(settings.xp) + "/" + F.xpMax);
    if (formEl) { formEl.textContent = F.name; formEl.style.color = FORM_COLOR[settings.stage]; }
    var tone = HUD_TONE[state] || HUD_TONE.idle;
    if (stEl) { stEl.textContent = tone[1]; stEl.style.color = tone[0]; }
    if (dot) { dot.style.background = tone[0]; dot.style.boxShadow = (state==="idle") ? "none" : "0 0 7px " + tone[0]; }
  }

  var STATES = {
    idle:{flameI:1.0,walk:0,bobAmp:1,roarCenter:true,roarSide:false,tailSpeed:0.10,sad:0},
    running:{flameI:1.5,walk:1,bobAmp:1.5,roarCenter:true,roarSide:true,tailSpeed:0.30,sad:0},
    review:{flameI:0.8,walk:0,bobAmp:0.6,roarCenter:false,roarSide:false,tailSpeed:0.06,sad:0},
    failed:{flameI:0.4,walk:0,bobAmp:0.4,roarCenter:false,roarSide:false,tailSpeed:0.03,sad:1},
    waving:{flameI:1.2,walk:0,bobAmp:1.2,roarCenter:true,roarSide:false,tailSpeed:0.35,sad:0},
    jumping:{flameI:1.6,walk:0,bobAmp:0,roarCenter:true,roarSide:true,tailSpeed:0.25,sad:0},
    waiting:{flameI:0.7,walk:0,bobAmp:0.8,roarCenter:false,roarSide:false,tailSpeed:0.05,sad:0.3}
  };

  var state = "idle";
  var frame = 0;
  var petX = window.innerWidth - 170, petY = window.innerHeight - 140;
  var mouseX = petX, mouseY = petY - 100;
  var facing = -1;
  var jumpT = -1;
  var paused = false;

  /* ── evolution ladder ── */
  var EVOLVE_MS = 20 * 60 * 1000;
  var bornAt = Date.now();
  var evolving = false;
  var evolveT = 0;

  function gainXP(n) {
    if (settings.stage >= FORMS.length - 1) return;   /* ALPHA is the apex */
    settings.xp += n;
    var F = FORMS[settings.stage];
    if (settings.autoEvolve && settings.xp >= F.xpMax) doEvolve();
    saveSettings(); updatePanel(); updateHud();
  }
  function doEvolve() {
    if (settings.stage >= FORMS.length - 1 || evolving) return;
    evolving = true; evolveT = 0;
  }
  function finishEvolve() {
    settings.stage = Math.min(FORMS.length - 1, settings.stage + 1);
    settings.xp = 0;
    evolving = false; evolveT = 0;
    saveSettings(); applyCanvasStyle(); updatePanel(); updateHud();
  }
  function setForm(stage) {
    stage = Math.max(0, Math.min(FORMS.length - 1, stage|0));
    settings.stage = stage; settings.xp = 0; evolving = false; evolveT = 0;
    saveSettings(); applyCanvasStyle(); updatePanel(); updateHud();
  }
  function resetToBase() { setForm(0); }

  /* ── easter eggs ── */
  var egg = null, eggT = 0;
  var EGG_INTERVAL = 5 * 60 * FPS;
  var EGG_DURATION = 4 * FPS;
  var nextEggIn = EGG_INTERVAL;

  /* per-form egg pools — ULTRA/OMEGA/ALPHA get 5 cooler eggs each */
  var EGGS = {
    0: ["play","fire","howl"],
    1: ["play","fire","howl"],
    2: ["inferno","crownflare","lavasurge","triplehowl","meteor"],
    3: ["omegaflare","goldnova","realmgate","omegahowl","extinction"],
    4: ["omegaflare","goldnova","realmgate","omegahowl","extinction"]
  };

  window.addEventListener("mousemove", function (e) { mouseX = e.clientX; mouseY = e.clientY; });

  function setState(s) {
    if (!STATES[s]) return;
    state = s;
    if (s === "jumping") jumpT = 0;
    if (s !== "idle") { egg = null; eggT = 0; }
    updateHud();
  }

  window.cerbPetEgg = function (name) {
    setState("idle"); egg = name; eggT = 0;
  };

  /* tool-call-type reactivity — different tool categories give different XP
     and can nudge the pet into a matching pose. Called by the SSE bridge. */
  var TOOL_XP = { terminal:2, file:2, code:3, web:2, browser:2, search:2, delegate:3, vision:2, default:1 };
  window.cerbPetTool = function (toolType, phase) {
    if (phase === "end") return;   /* only reward the start of work */
    var xp = TOOL_XP[toolType] || TOOL_XP.default;
    gainXP(xp);
    if (toolType === "delegate" || toolType === "code") setState("review");
    else setState("running");
  };

  window.cerbPetReact = function (mode) {
    if (mode === "thinking" || mode === "processing") { setState("review"); gainXP(2); }
    else if (mode === "working") { setState("running"); gainXP(1); }
    else if (mode === "done") { setState("waving"); gainXP(3); }
    else if (mode === "error") { setState("failed"); }
    else if (mode === "offline") { setState("failed"); }
    else if (mode === "online") { setState("idle"); }
    else if (mode === "idle") { setState("idle"); }
  };
  window.cerbPetSetState = setState;
  window.cerbPetEvolve = doEvolve;
  window.cerbPetSetForm = setForm;
  window.cerbPetGetInfo = function () {
    return { stage:settings.stage, form:FORMS[settings.stage].key, name:FORMS[settings.stage].name,
             xp:settings.xp, xpMax:FORMS[settings.stage].xpMax, enabled:settings.enabled,
             scale:settings.scale, glow:settings.glow, autoEvolve:settings.autoEvolve, state:state };
  };

  document.addEventListener("visibilitychange", function () { paused = document.hidden; });

  /* ── settings panel ── */
  var gear = document.createElement("button");
  gear.id = "cerbPetGear";
  gear.title = "Cerberus pet settings";
  gear.innerHTML = "&#9881;";
  gear.style.cssText = "position:fixed;z-index:10000;right:14px;top:54px;width:34px;height:34px;border-radius:50%;border:1px solid rgba(224,69,26,0.5);background:rgba(18,10,10,0.85);color:#e8b84a;font-size:17px;line-height:1;cursor:pointer;pointer-events:auto;transition:transform .15s, border-color .15s;";
  gear.onmouseenter = function(){ gear.style.transform="rotate(45deg)"; gear.style.borderColor="#ff8a1e"; };
  gear.onmouseleave = function(){ gear.style.transform="rotate(0deg)"; gear.style.borderColor="rgba(224,69,26,0.5)"; };
  document.body.appendChild(gear);

  var panel = document.createElement("div");
  panel.id = "cerbPetPanel";
  panel.style.cssText = "position:fixed;z-index:10001;right:14px;top:96px;width:240px;background:rgba(16,9,9,0.96);border:1px solid rgba(224,69,26,0.45);border-radius:10px;padding:14px;font-family:inherit;color:#e8e0d8;font-size:12px;display:none;pointer-events:auto;box-shadow:0 8px 24px rgba(0,0,0,0.6);";
  document.body.appendChild(panel);

  var panelOpen = false;
  gear.addEventListener("click", function () {
    panelOpen = !panelOpen;
    panel.style.display = panelOpen ? "block" : "none";
    if (panelOpen) updatePanel();
  });

  function row(label) {
    var d = document.createElement("div");
    d.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin:8px 0;";
    var l = document.createElement("span"); l.textContent = label; l.style.cssText = "color:#c9beb0;";
    d.appendChild(l); return d;
  }
  function toggle(get, set) {
    var b = document.createElement("button");
    b.style.cssText = "width:40px;height:20px;border-radius:10px;border:1px solid rgba(224,69,26,0.5);background:#2a1512;position:relative;cursor:pointer;padding:0;";
    var knob = document.createElement("span");
    knob.style.cssText = "position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#8a8078;transition:left .15s, background .15s;";
    b.appendChild(knob);
    function paint(){ var on=get(); knob.style.left=on?"22px":"2px"; knob.style.background=on?"#ff8a1e":"#8a8078"; b.style.background=on?"rgba(224,69,26,0.35)":"#2a1512"; }
    b.addEventListener("click", function(){ set(!get()); paint(); saveSettings(); applyCanvasStyle(); updateHud(); });
    paint(); return b;
  }
  function btn(label, fn, accent) {
    var b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = "width:100%;margin:6px 0 0;padding:7px 0;border-radius:6px;border:1px solid " + (accent?"rgba(255,138,30,0.6)":"rgba(224,69,26,0.4)") + ";background:" + (accent?"rgba(255,138,30,0.15)":"rgba(224,69,26,0.1)") + ";color:" + (accent?"#ffd97a":"#e8b84a") + ";font-size:12px;font-family:inherit;cursor:pointer;";
    b.addEventListener("click", fn); return b;
  }

  function buildPanel() {
    panel.innerHTML = "";
    var title = document.createElement("div");
    title.innerHTML = "<b style='color:#ffd97a;font-size:13px;letter-spacing:1px;'>CERBERUS PET</b>";
    title.style.cssText = "margin-bottom:6px;border-bottom:1px solid rgba(224,69,26,0.3);padding-bottom:6px;";
    panel.appendChild(title);

    var stageLine = document.createElement("div");
    stageLine.id = "cerbPetStage";
    stageLine.style.cssText = "margin:6px 0;color:#c9beb0;";
    panel.appendChild(stageLine);

    var xpWrap = document.createElement("div");
    xpWrap.style.cssText = "height:6px;border-radius:3px;background:#2a1512;overflow:hidden;margin:4px 0 8px;";
    var xpBar = document.createElement("div");
    xpBar.id = "cerbPetXP";
    xpBar.style.cssText = "height:100%;width:0%;background:linear-gradient(90deg,#e0451a,#ff8a1e,#ffd24a);border-radius:3px;transition:width .3s;";
    xpWrap.appendChild(xpBar); panel.appendChild(xpWrap);

    /* form switcher — one button per form, manual select */
    var formLabel = document.createElement("div");
    formLabel.textContent = "Form"; formLabel.style.cssText = "color:#c9beb0;margin:8px 0 4px;";
    panel.appendChild(formLabel);
    var formRow = document.createElement("div");
    formRow.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:4px;";
    var shortNames = ["Pup","Prime","Ultra","Omega","Alpha"];
    for (var fi=0; fi<FORMS.length; fi++) {
      (function(idx){
        var b = document.createElement("button");
        b.textContent = shortNames[idx];
        b.setAttribute("data-form", idx);
        b.style.cssText = "padding:6px 0;border-radius:6px;border:1px solid rgba(224,69,26,0.4);background:rgba(224,69,26,0.1);color:" + FORM_COLOR[idx] + ";font-size:11px;font-family:inherit;cursor:pointer;";
        b.addEventListener("click", function(){ setForm(idx); });
        formRow.appendChild(b);
      })(fi);
    }
    panel.appendChild(formRow);

    var r1 = row("Show pet"); r1.appendChild(toggle(function(){return settings.enabled;}, function(v){settings.enabled=v;})); panel.appendChild(r1);
    var r2 = row("Ember glow"); r2.appendChild(toggle(function(){return settings.glow;}, function(v){settings.glow=v;})); panel.appendChild(r2);
    var r3 = row("Auto-evolve"); r3.appendChild(toggle(function(){return settings.autoEvolve;}, function(v){settings.autoEvolve=v;})); panel.appendChild(r3);

    var r4 = row("Size");
    var sizes = document.createElement("span");
    [2,3,4].forEach(function(s){
      var b = document.createElement("button");
      b.textContent = s+"x";
      b.style.cssText = "width:30px;height:22px;margin-left:4px;border-radius:5px;border:1px solid rgba(224,69,26,0.4);background:rgba(224,69,26,0.1);color:#e8b84a;font-size:11px;cursor:pointer;";
      b.addEventListener("click", function(){ settings.scale=s; saveSettings(); applyCanvasStyle(); updatePanel(); });
      b.setAttribute("data-size", s);
      sizes.appendChild(b);
    });
    r4.appendChild(sizes); panel.appendChild(r4);

    panel.appendChild(btn("Evolve now", function(){ doEvolve(); }, true));
    panel.appendChild(btn("Reset to pup", function(){ resetToBase(); }, false));
  }
  buildPanel();

  function updatePanel() {
    var stageEl = document.getElementById("cerbPetStage");
    var xpEl = document.getElementById("cerbPetXP");
    var F = FORMS[settings.stage];
    if (stageEl) {
      if (settings.stage >= FORMS.length - 1) stageEl.innerHTML = "Form: <b style='color:#fffbe8;'>ALPHA CERBERUS</b> &nbsp;·&nbsp; MAX";
      else stageEl.innerHTML = "Form: <b style='color:" + FORM_COLOR[settings.stage] + ";'>" + F.name + "</b> &nbsp;·&nbsp; XP " + Math.floor(settings.xp) + "/" + F.xpMax;
    }
    if (xpEl) xpEl.style.width = (settings.stage>=FORMS.length-1 ? 100 : Math.min(100, (settings.xp/F.xpMax)*100)) + "%";
    var sizeBtns = panel.querySelectorAll("[data-size]");
    for (var i=0;i<sizeBtns.length;i++) {
      var on = parseInt(sizeBtns[i].getAttribute("data-size")) === settings.scale;
      sizeBtns[i].style.background = on ? "rgba(255,138,30,0.4)" : "rgba(224,69,26,0.1)";
    }
    var formBtns = panel.querySelectorAll("[data-form]");
    for (var j=0;j<formBtns.length;j++) {
      var fon = parseInt(formBtns[j].getAttribute("data-form")) === settings.stage;
      formBtns[j].style.background = fon ? "rgba(255,138,30,0.4)" : "rgba(224,69,26,0.1)";
      formBtns[j].style.borderColor = fon ? "rgba(255,138,30,0.8)" : "rgba(224,69,26,0.4)";
    }
  }
  updatePanel();
  updateHud();

  /* ── easter-egg pose application (per-form, cooler for ULTRA/OMEGA) ── */
  function applyEgg(P, flameI, eggEnv) {
    if (!egg) return;
    var e = eggEnv;
    /* base / prime eggs */
    if (egg === "play") {
      P.headL=e*6; P.headR=-e*6; P.gazeLOverride=1; P.gazeROverride=-1;
      P.roarCenter=false; P.roarSide=false; if (e>0.5) P.blink=1; P.tailWag=frame*0.3*2;
    } else if (egg === "fire") {
      P.fireBreath=e; P.roarCenter=true; P.flameI=flameI+e*0.5;
    } else if (egg === "howl") {
      P.howl=e; P.roarCenter=true; P.roarSide=true; P.flameI=flameI+e*0.8; if (e>0.4) P.blink=1;
    }
    /* ULTRA eggs */
    else if (egg === "inferno") {           /* all three heads breathe fire */
      P.fireBreath=e; P.roarCenter=true; P.roarSide=true; P.flameI=flameI+e*1.2;
      P.headL=e*2; P.headR=-e*2;
    } else if (egg === "crownflare") {      /* crown crest blazes, heads bow then rise */
      P.runeFlare=true; P.howl=e*0.6; P.roarCenter=true; P.flameI=flameI+e*0.9;
      P.headC=-e*3;
    } else if (egg === "lavasurge") {       /* crouch, magma pulse, ground erupts */
      P.squash=1+e*0.15; P.runeFlare=true; P.flameI=flameI+e*1.0; P.roarCenter=true;
    } else if (egg === "triplehowl") {      /* three heads howl in sequence */
      P.howl=e; P.roarCenter=true; P.roarSide=true; P.flameI=flameI+e*1.0;
      P.headL=Math.sin(frame*0.4)*e*4; P.headR=Math.sin(frame*0.4+2)*e*4; if (e>0.3) P.blink=1;
    } else if (egg === "meteor") {          /* rears up, fire rains from above */
      P.howl=e*0.8; P.roarCenter=true; P.roarSide=true; P.flameI=flameI+e*1.3; P.meteor=e;
    }
    /* OMEGA eggs */
    else if (egg === "omegaflare") {        /* sustained white-hot beam */
      P.fireBreath=e; P.roarCenter=true; P.roarSide=true; P.flameI=flameI+e*1.4; P.runeFlare=true;
    } else if (egg === "goldnova") {        /* golden shockwave ring burst */
      P.runeFlare=true; P.nova=e; P.roarCenter=true; P.flameI=flameI+e*1.1;
    } else if (egg === "realmgate") {       /* eyes blaze, aura intensifies, portal shimmer */
      P.runeFlare=true; P.gate=e; P.roarCenter=true; P.roarSide=true; P.flameI=flameI+e*1.2;
    } else if (egg === "omegahowl") {       /* apex howl — heads fan wide, crown flares */
      P.howl=e; P.roarCenter=true; P.roarSide=true; P.flameI=flameI+e*1.3;
      P.headL=e*8; P.headR=-e*8; P.runeFlare=true; if (e>0.3) P.blink=1;
    } else if (egg === "extinction") {      /* the big one — meteor storm + nova + beam */
      P.fireBreath=e; P.roarCenter=true; P.roarSide=true; P.flameI=flameI+e*1.6;
      P.runeFlare=true; P.meteor=e; P.nova=e*0.7;
    }
  }

  var lastDraw = 0;
  /* render one form (by stage index) into its off-screen buffer; returns its
     buffer + dims so callers (e.g. the evolution crossfade) can composite it */
  function renderForm(stage, P) {
    var b = bufs[stage];
    var octx = b.ctx;
    var Fm = FORMS[stage];
    var pal = PALS[Fm.pal];
    var res = Fm.res||1;
    if (res > 1) {
      /* High-density form: draw the existing logical-space art through a
         res-scale so every primitive lands at res× fidelity, then post-process
         at full buffer resolution. Same silhouette, dramatically more detail. */
      octx.save(); octx.scale(res, res);
    }
    if (stage === 0) { if (P.view==="front") drawPupFront(octx,P); else drawPupSide(octx,P); }
    else if (stage === 1) { if (P.view==="front") drawPrimeFront(octx,P); else drawPrimeSide(octx,P); }
    else if (stage === 2) { if (P.view==="front") drawUltraFront(octx,P); else drawUltraSide(octx,P); }
    else if (stage === 3) { if (P.view==="front") drawOmegaFront(octx,P); else drawOmegaSide(octx,P); }
    else { if (P.view==="front") drawAlphaFront(octx,P); else drawAlphaSide(octx,P); }
    if (res > 1) octx.restore();
    applyRim(octx, Fm.w*res, Fm.h*res, pal);
    applyOutline(octx, Fm.w*res, Fm.h*res, pal.outline);
    return { canvas:b.canvas, w:Fm.w*res, h:Fm.h*res, pal:pal };
  }

  function tick(now) {
    requestAnimationFrame(tick);
    if (paused || !settings.enabled) return;
    if (now - lastDraw < FRAME_MS - 1) return;
    lastDraw = now;
    frame += TICKS_PER_FRAME;

    var S = STATES[state];
    var F = FORMS[settings.stage];

    /* evolution: uptime timer + random chance while working */
    if (!evolving && settings.stage < FORMS.length - 1 && settings.autoEvolve) {
      if (Date.now() - bornAt > EVOLVE_MS) doEvolve();
      else if ((state === "running" || state === "review") && Math.random() < 0.0006) doEvolve();
    }
    if (evolving) {
      evolveT += 1/(2.2*FPS);
      var evSt = document.getElementById("cerbHudState");
      if (evSt) { evSt.textContent = "EVOLVING"; evSt.style.color = "#fff4d0"; }
      if (evolveT >= 1) finishEvolve();
    }

    /* easter-egg scheduling (idle only) — pool depends on form */
    if (state === "idle" && !egg) {
      nextEggIn--;
      if (nextEggIn <= 0) {
        var pool = EGGS[settings.stage] || EGGS[0];
        egg = pool[Math.floor(Math.random()*pool.length)];
        eggT = 0;
        nextEggIn = EGG_INTERVAL + Math.floor(Math.random()*900);
      }
    }
    var eggEnv = 0;
    if (egg) {
      eggT += 1/EGG_DURATION;
      eggEnv = eggT < 0.2 ? eggT/0.2 : (eggT > 0.8 ? (1-eggT)/0.2 : 1);
      eggEnv = Math.max(0, Math.min(1, eggEnv));
      if (eggT >= 1) { egg = null; eggT = 0; eggEnv = 0; }
    }

    /* movement */
    var walkPhase = 0, moving = false;
    if (state === "running") {
      var dx = mouseX - petX;
      if (Math.abs(dx) > 6) {
        walkPhase = frame*0.35;
        petX += (dx>0?1:-1)*Math.min(Math.abs(dx), 2.2);
        facing = dx>0?1:-1; moving = true;
      }
    } else if ((state === "idle" || state === "waiting") && !egg) {
      var dx2 = mouseX-petX, dy2 = mouseY-petY;
      var dist = Math.sqrt(dx2*dx2+dy2*dy2);
      if (dist > 160) {
        walkPhase = frame*0.25;
        petX += (dx2/dist)*1.4; petY += (dy2/dist)*1.0;
        if (Math.abs(dx2) > 4) facing = dx2>0?1:-1;
        moving = true;
      }
      petY = Math.max(window.innerHeight*0.4, Math.min(window.innerHeight-140, petY));
      petX = Math.max(40, Math.min(window.innerWidth-40, petX));
    }
    var viewFront = !moving;

    /* gaze */
    var gdx = mouseX-petX, gdy = mouseY-petY;
    var gazeX = Math.max(-1, Math.min(1, Math.round(gdx/60)));
    var gazeY = Math.max(-1, Math.min(1, Math.round(gdy/80)));
    var runeFlare = false;
    if (state === "review") {
      gazeX = Math.max(-1, Math.min(1, Math.round(Math.sin(frame*0.15)*1.4)));
      gazeY = 0; runeFlare = true;
    } else if (state === "failed") { gazeX = 0; gazeY = 1; }

    var bob = reduced ? 0 : Math.sin(frame*0.07)*S.bobAmp;
    var squash = 1, yOff = 0;
    if (state === "jumping") {
      jumpT += 0.06*TICKS_PER_FRAME;
      var arc = Math.sin(Math.min(1, jumpT)*Math.PI);
      yOff = -arc*26; squash = 1+arc*0.25-(jumpT<0.15?0.2:0);
      if (jumpT >= 1.15) setState("idle");
    }

    /* progressive flame intensity per tier */
    var flameI = S.flameI * F.flame;

    var P = {
      bob:bob, walk:walkPhase, flameI:flameI, flick:frame,
      gazeX:gazeX, gazeY:gazeY, squash:squash, sad:S.sad,
      lean:(state==="running")?3:0,
      tailWag:frame*S.tailSpeed*2,
      roarCenter:S.roarCenter, roarSide:S.roarSide,
      blink:(frame%110<4)?1:0,
      view:viewFront?"front":"side",
      wave:(state==="waving")?1:0,
      runeFlare:runeFlare,
      stage:settings.stage
    };

    applyEgg(P, flameI, eggEnv);

    /* render the right form into its buffer */
    renderForm(settings.stage, P);
    var b = bufs[settings.stage];
    var res = F.res||1;
    var sw = F.w*res, sh = F.h*res;   /* buffer (pixel) size of the current form */
    var DW = canvas.width, DH = canvas.height;   /* display buffer size */
    var pal = PALS[F.pal];

    nctx.clearRect(0,0,DW,DH);

    if (evolving) {
      /* 3-phase evolution: charge-up glow + inward streaks -> bright flash ->
         new form emerges with thick expanding shockwave rings + outward burst.
         Effects are deliberately bold so the moment reads at any scale. */
      var oldStage = settings.stage;
      var newStage = Math.min(FORMS.length - 1, settings.stage + 1);
      var Fnew = FORMS[newStage];
      var resNew = Fnew.res||1;
      /* Size the display canvas to the EMERGING form's buffer for the duration
         of the transition, so a higher-density form (OMEGA at 2×) is never
         clipped to the old form's smaller canvas. The CSS footprint grows to
         the new form's logical size at the same moment the charge-up begins,
         reading as the creature swelling with energy. */
      if (canvas.width !== Fnew.w*resNew || canvas.height !== Fnew.h*resNew) {
        canvas.width = Fnew.w*resNew; canvas.height = Fnew.h*resNew;
        canvas.style.width = (Fnew.w*settings.scale) + "px";
        canvas.style.height = (Fnew.h*settings.scale) + "px";
      }
      DW = canvas.width; DH = canvas.height;
      var cx=DW/2, cy=DH*0.55;
      var rold = renderForm(oldStage, P);
      var rnew = renderForm(newStage, P);
      var oxOld = Math.round((DW-rold.w)/2), oyOld = DH-rold.h;
      var oxNew = Math.round((DW-rnew.w)/2), oyNew = DH-rnew.h;
      var shake = (evolveT < 0.4) ? Math.sin(frame*1.5)*(evolveT/0.4)*3*resNew : 0;
      nctx.save();
      if (evolveT < 0.5) {
        /* PHASE 1 — old form charges up: glows white-hot, shakes, energy streaks IN */
        var p1 = evolveT/0.5;
        var a = evolveT < 0.4 ? 1 : Math.max(0, 1-(evolveT-0.4)/0.1);
        nctx.globalAlpha = a;
        nctx.drawImage(rold.canvas, oxOld+shake, oyOld);
        nctx.globalCompositeOperation = "lighter";
        nctx.globalAlpha = p1*0.9*a;
        nctx.drawImage(rold.canvas, oxOld+shake, oyOld);    /* white-hot build */
        nctx.drawImage(rold.canvas, oxOld+shake, oyOld);    /* double-pass = hotter */
        /* inward energy streaks — each drawn as a short radial line so motion reads */
        for (var ep=0; ep<12; ep++) {
          var ang = ep*(Math.PI*2/12) + frame*0.05;
          var radOut = ((1-p1)*46 + 6)*resNew;
          var radIn = radOut - 9*resNew;
          nctx.globalAlpha = (0.4 + 0.5*p1);
          nctx.strokeStyle = ep%2 ? "#ffd878" : "#ff9a2a"; nctx.lineWidth = 2*resNew;
          nctx.beginPath();
          nctx.moveTo(cx+Math.cos(ang)*radOut, cy+Math.sin(ang)*radOut*0.7);
          nctx.lineTo(cx+Math.cos(ang)*radIn, cy+Math.sin(ang)*radIn*0.7);
          nctx.stroke();
        }
        nctx.globalCompositeOperation = "source-over";
      } else {
        /* PHASE 2 — new form emerges from a bright flash */
        var t2 = (evolveT-0.5)/0.5;
        /* bright full-canvas flash that peaks at the transition then decays */
        var flashA = Math.max(0, 1 - t2*1.6);
        nctx.globalAlpha = flashA*0.85;
        nctx.fillStyle = "#fff8e0";
        nctx.fillRect(0, 0, DW, DH);
        /* central bloom */
        nctx.globalAlpha = Math.max(0, 1-t2);
        nctx.fillStyle = "#fffef0";
        nctx.beginPath(); nctx.arc(cx, cy, (12+t2*46)*resNew, 0, Math.PI*2); nctx.fill();
        /* new form fades in over the flash */
        nctx.globalAlpha = Math.min(1, t2*1.5);
        nctx.drawImage(rnew.canvas, oxNew, oyNew);
        /* thick expanding shockwave rings */
        nctx.globalCompositeOperation = "lighter";
        for (var rr=0; rr<3; rr++) {
          var rt = Math.min(1, t2*1.2 + rr*0.18);
          nctx.globalAlpha = (1-rt)*0.9;
          nctx.strokeStyle = rr%2 ? "#ffd878" : "#ff9a2a"; nctx.lineWidth = 3*resNew;
          nctx.beginPath(); nctx.arc(cx, cy, rt*58*resNew, 0, Math.PI*2); nctx.stroke();
        }
        /* outward particle burst with short trails so motion reads */
        for (var bp=0; bp<16; bp++) {
          var bang = bp*(Math.PI*2/16) + 0.2;
          var brad = t2*54*resNew;
          var brad0 = Math.max(0, brad-8*resNew);
          nctx.globalAlpha = (1-t2);
          nctx.strokeStyle = bp%3===0 ? "#fff4d0" : (bp%2 ? "#ffd878" : "#ff5a00");
          nctx.lineWidth = 2*resNew;
          nctx.beginPath();
          nctx.moveTo(cx+Math.cos(bang)*brad0, cy+Math.sin(bang)*brad0*0.75);
          nctx.lineTo(cx+Math.cos(bang)*brad, cy+Math.sin(bang)*brad*0.75);
          nctx.stroke();
        }
        nctx.globalCompositeOperation = "source-over";
      }
      nctx.restore();
    } else {
      var ox = Math.round((DW-sw)/2), oy = DH-sh;
      pxEllipse(nctx, DW/2, DH-2*res, Math.round(sw*0.42), 2*res, "rgba(0,0,0,0.5)");
      nctx.save();
      if (P.view === "side" && facing > 0) { nctx.translate(DW, 0); nctx.scale(-1, 1); ox = DW-ox-sw; }
      nctx.drawImage(b.canvas, ox, oy);
      nctx.restore();

      /* egg FX layered on the display buffer (in buffer-pixel space) */
      var fcx = DW/2;
      if (P.nova) {   /* golden shockwave rings */
        nctx.save();
        for (var nr=0; nr<3; nr++) {
          var rt = (P.nova + nr*0.18) % 1;
          nctx.globalAlpha = (1-rt)*0.8;
          nctx.strokeStyle = nr%2 ? "#ffd878" : "#ff9a2a"; nctx.lineWidth = 2*res;
          nctx.beginPath(); nctx.arc(fcx, DH*0.55, rt*52*res, 0, Math.PI*2); nctx.stroke();
        }
        nctx.restore();
      }
      if (P.meteor) {   /* fire raining from above */
        nctx.save();
        for (var mr=0; mr<7; mr++) {
          var mt = ((frame*0.05 + mr*0.14) % 1);
          var mxp = fcx-40*res + ((mr*29*res)%(80*res));
          var myp = mt*DH*0.7;
          nctx.globalAlpha = (1-mt)*P.meteor;
          nctx.fillStyle = mr%2 ? "#ffd84a" : "#ff5a00";
          nctx.fillRect(Math.round(mxp), Math.round(myp), 2*res, 3*res);
          nctx.fillStyle = "#fff0b0";
          nctx.fillRect(Math.round(mxp), Math.round(myp)-res, res, res);
        }
        nctx.restore();
      }
      if (P.gate) {   /* realm gate shimmer — vertical portal bars */
        nctx.save();
        for (var gr=0; gr<5; gr++) {
          var gxp = fcx-24*res + gr*12*res;
          nctx.globalAlpha = (0.3+0.3*Math.sin(frame*0.2+gr))*P.gate;
          nctx.fillStyle = gr%2 ? "#ffd878" : "#ff5a1e";
          nctx.fillRect(Math.round(gxp), Math.round(DH*0.2), 2*res, Math.round(DH*0.5));
        }
        nctx.restore();
      }
    }
    drawEmbers(nctx, P, DW, DH, res, pal);

    /* OMEGA gets the CRT scanline + vignette overlay on top */
    if (settings.stage >= 3 && !evolving) applyScanlines(nctx, DW, DH, res);

    var sc = settings.scale;
    var dispW = F.w*sc, dispH = F.h*sc;
    canvas.style.left = (petX - dispW/2) + "px";
    canvas.style.top = (petY - dispH + yOff*sc) + "px";
  }
  requestAnimationFrame(tick);
})();
</script>
</body>
</html>`;
}

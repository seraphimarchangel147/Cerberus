import fs from "node:fs";
import path from "node:path";
import { types as utilTypes } from "node:util";
import {
  appendJsonLine,
  ensureDir,
  readJsonFile,
  writeJsonAtomic
} from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";
import { nowIso } from "./utils.js";

export const DEFAULT_PROJECT_ID = "default";
export const PROJECT_STATUSES = Object.freeze({
  ACTIVE: "active",
  ARCHIVED: "archived"
});

const PROJECT_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const CAPABILITY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOOL_POLICIES = new Set(["full", "confirm", "read-only", "none"]);
const RESOURCE_FIELDS = new Set([
  "artifactIds",
  "hookIds",
  "recipeIds",
  "scheduleIds"
]);
const MAX_PROJECTS = 256;
const MAX_LIST_ITEMS = 256;
const MAX_INSTRUCTIONS_CHARS = 32_000;
const MAX_PROFILE_KEYS = 32;
const MAX_PROFILE_DEPTH = 4;
const MAX_PROFILE_NODES = 1_024;
const MAX_PROFILE_CHARS = 64_000;
const MAX_SESSION_BINDINGS = 10_000;
const MAX_SESSION_ID_CHARS = 512;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_REPLAY_BYTES = 32 * 1024 * 1024;
const MAX_EVENT_LINE_BYTES = 16 * 1024 * 1024;
const MAX_STATE_BYTES = 12 * 1024 * 1024;
const PROJECT_LOCK_RETRY_MS = 10;
const DEFAULT_PROJECT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_PROJECT_STALE_LOCK_MS = 60_000;
const PROJECT_LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const SESSION_ID_RE = /^[\x21-\x7E]{1,512}$/;
const EVENT_OP_RE = /^[a-z][a-z-]{0,63}$/;
const SENSITIVE_PROFILE_KEY = /(?:^|[_.:/-])(?:api.?key|authorization|bearer|cookie|credential|password|private.?key|access.?token|refresh.?token|secret|token)(?:$|[_.:/-])/i;
const CREATE_FIELDS = new Set([
  "activeSkills",
  "artifactIds",
  "hookIds",
  "id",
  "instructions",
  "kanbanBoardId",
  "mcpGrants",
  "modelProfile",
  "name",
  "policy",
  "recipeIds",
  "routingProfile",
  "scheduleIds",
  "secretRefs",
  "workspaceRoot"
]);
const UPDATE_FIELDS = new Set([
  "activeSkills",
  "artifactIds",
  "expectedRevision",
  "hookIds",
  "instructions",
  "kanbanBoardId",
  "mcpGrants",
  "modelProfile",
  "name",
  "policy",
  "recipeIds",
  "routingProfile",
  "scheduleIds",
  "secretRefs",
  "workspaceRoot"
]);
const STORED_PROJECT_FIELDS = new Set([
  "activeSkills",
  "archivedAt",
  "artifactIds",
  "createdAt",
  "createdBy",
  "hookIds",
  "id",
  "instructions",
  "kanbanBoardId",
  "mcpGrants",
  "memoryScope",
  "modelProfile",
  "name",
  "policy",
  "recipeIds",
  "revision",
  "routingProfile",
  "scheduleIds",
  "secretRefs",
  "status",
  "updatedAt",
  "updatedBy",
  "version",
  "workspaceRoot"
]);
const STORED_STATE_FIELDS = new Set([
  "projects",
  "selectedProjectId",
  "sequence",
  "sessionBindings",
  "updatedAt",
  "version"
]);

export class ProjectBoundaryError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProjectBoundaryError";
    this.code = "PROJECT_BOUNDARY_VIOLATION";
    Object.assign(this, details);
  }
}

export class ProjectRevisionError extends Error {
  constructor(projectId, expectedRevision, actualRevision) {
    super(
      `Project revision conflict for '${projectId}': expected ${expectedRevision}, found ${actualRevision ?? "none"}.`
    );
    this.name = "ProjectRevisionError";
    this.code = "PROJECT_REVISION_CONFLICT";
    this.projectId = projectId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision ?? null;
  }
}

// Durable composition root for every project-scoped runtime capability.
//
// Each mutation appends a complete, validated post-mutation state before an
// atomic snapshot is replaced. Session ownership is intentionally immutable.
// selectedProjectId is a presentation hint for single-user clients only; it is
// never consulted when authorizing or binding a request.
export class ProjectStore {
  constructor(options = {}) {
    const source = plainDataRecord(options, "ProjectStore options");
    const dataDir = path.resolve(source.dataDir ?? resolveDataDir());
    this.dir = path.resolve(source.dir ?? path.join(dataDir, "projects"));
    this.workspaceBase = path.resolve(
      source.workspaceBase ?? path.join(dataDir, "project-workspaces")
    );
    this.defaultWorkspaceRoot = path.resolve(
      source.defaultWorkspaceRoot
      ?? source.workspaceRoot
      ?? process.cwd()
    );
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.snapshotPath = path.join(this.dir, "snapshot.json");
    this.lockPath = path.join(this.dir, ".mutation.lock");
    this.now = typeof source.now === "function" ? source.now : nowIso;
    this.onChange = typeof source.onChange === "function" ? source.onChange : null;
    this.appendEvent = typeof source.appendEvent === "function"
      ? source.appendEvent
      : appendJsonLine;
    this.writeSnapshot = typeof source.writeSnapshot === "function"
      ? source.writeSnapshot
      : writeJsonAtomic;
    this.lockTimeoutMs = positiveInteger(
      source.lockTimeoutMs,
      DEFAULT_PROJECT_LOCK_TIMEOUT_MS
    );
    this.staleLockMs = positiveInteger(
      source.staleLockMs,
      DEFAULT_PROJECT_STALE_LOCK_MS
    );
    this.lockDepth = 0;
    this.mutationChanges = null;
    this.projects = new Map();
    this.sessionProjects = new Map();
    this.selectedProjectId = DEFAULT_PROJECT_ID;
    this.sequence = 0;

    ensureDir(this.dir);
    ensureDir(this.workspaceBase);
    ensureDir(this.defaultWorkspaceRoot);
    this._runMutation(() => this._ensureDefaultProject());
  }

  list(options = {}) {
    const { includeArchived = false } = plainDataRecord(options, "list options");
    requireBoolean(includeArchived, "includeArchived");
    return [...this.projects.values()]
      .filter((project) => includeArchived || project.status === PROJECT_STATUSES.ACTIVE)
      .sort((left, right) => (
        left.id === DEFAULT_PROJECT_ID
          ? -1
          : right.id === DEFAULT_PROJECT_ID
            ? 1
            : left.name.localeCompare(right.name)
      ))
      .map((project) => this._view(project));
  }

  get(projectId, options = {}) {
    const { includeArchived = true } = plainDataRecord(options, "get options");
    requireBoolean(includeArchived, "includeArchived");
    const id = normalizeProjectId(projectId);
    const project = this.projects.get(id) ?? null;
    if (!project || (!includeArchived && project.status === PROJECT_STATUSES.ARCHIVED)) {
      return null;
    }
    return this._view(project);
  }

  // Authorization reads deliberately bypass the instance-local presentation
  // cache. A second daemon may have revoked a grant or archived a project
  // since this process last mutated state, so every security decision is made
  // from the latest event-backed state while holding the shared lock.
  authorize(projectId, options = {}) {
    const {
      includeArchived = false,
      sessionId = null
    } = plainDataRecord(options, "project authorization options");
    requireBoolean(includeArchived, "includeArchived");
    const id = normalizeProjectId(projectId);
    const normalizedSessionId = sessionId == null || sessionId === ""
      ? null
      : normalizeSessionId(sessionId);
    return this._withMutationLock(() => {
      this._restoreDurableState();
      const project = this.projects.get(id) ?? null;
      if (
        !project
        || (!includeArchived && project.status === PROJECT_STATUSES.ARCHIVED)
      ) {
        return null;
      }
      if (normalizedSessionId) {
        const actual = this.sessionProjects.get(normalizedSessionId)
          ?? DEFAULT_PROJECT_ID;
        if (actual !== id) {
          throw new ProjectBoundaryError(
            `Session '${normalizedSessionId}' is outside project '${id}'.`,
            {
              projectId: id,
              sessionId: normalizedSessionId,
              actualProjectId: actual
            }
          );
        }
      }
      return this._view(project);
    });
  }

  selected() {
    const project = this.projects.get(this.selectedProjectId)
      ?? this.projects.get(DEFAULT_PROJECT_ID);
    return this._view(project);
  }

  create(input = {}, context = {}) {
    const source = plainDataRecord(input, "project");
    assertOnlyKeys(source, CREATE_FIELDS, "project");
    return this._runMutation(() => {
      if (this.projects.size >= MAX_PROJECTS) {
        throw new RangeError(`Project limit reached (${MAX_PROJECTS}).`);
      }
      const name = requiredText(source.name, "name", 200);
      const id = source.id
        ? normalizeProjectId(source.id)
        : this._uniqueProjectId(slugProjectName(name));
      if (id === DEFAULT_PROJECT_ID || this.projects.has(id)) {
        throw new Error(`Project '${id}' already exists.`);
      }
      const workspaceRoot = this._managedWorkspaceRoot(id, source.workspaceRoot);
      this._assertWorkspaceDisjoint(id, workspaceRoot);
      const at = this._now();
      const project = normalizeStoredProject({
        version: 1,
        id,
        name,
        status: PROJECT_STATUSES.ACTIVE,
        revision: 1,
        workspaceRoot,
        instructions: normalizeInstructions(source.instructions),
        memoryScope: `project:${id}`,
        secretRefs: normalizeSecretRefs(source.secretRefs),
        activeSkills: normalizeSkillRefs(source.activeSkills),
        modelProfile: normalizeProfile(source.modelProfile, "modelProfile"),
        routingProfile: normalizeProfile(source.routingProfile, "routingProfile"),
        mcpGrants: normalizeCapabilityList(source.mcpGrants, "mcpGrants"),
        policy: normalizeProjectPolicy(source.policy),
        hookIds: normalizeCapabilityList(source.hookIds, "hookIds"),
        scheduleIds: normalizeCapabilityList(source.scheduleIds, "scheduleIds"),
        kanbanBoardId: normalizeCapabilityName(
          source.kanbanBoardId ?? `project-${id}`,
          "kanbanBoardId"
        ),
        artifactIds: normalizeCapabilityList(source.artifactIds, "artifactIds"),
        recipeIds: normalizeCapabilityList(source.recipeIds, "recipeIds"),
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        createdBy: normalizeActor(context),
        updatedBy: normalizeActor(context)
      });
      this.projects.set(id, project);
      this._commit("create", id, { project: this._view(project) });
      return this._view(project);
    });
  }

  update(projectId, patch = {}, context = {}) {
    const source = plainDataRecord(patch, "project patch");
    assertOnlyKeys(source, UPDATE_FIELDS, "project patch");
    const id = normalizeProjectId(projectId);
    const contextValues = plainDataRecord(context, "update context");
    return this._runMutation(() => {
      const current = this._requireProject(id, { active: true });
      assertExpectedRevision(current, contextValues.expectedRevision ?? source.expectedRevision);
      if (current.revision >= Number.MAX_SAFE_INTEGER) {
        throw new RangeError("Project revision limit reached.");
      }

      const nextWorkspaceRoot = source.workspaceRoot === undefined
        ? current.workspaceRoot
        : id === DEFAULT_PROJECT_ID
          ? (() => {
              throw new ProjectBoundaryError("The default project workspace cannot be moved.");
            })()
          : this._managedWorkspaceRoot(id, source.workspaceRoot);
      if (
        nextWorkspaceRoot !== current.workspaceRoot
        && this.sessionsForProject(id).length > 0
      ) {
        throw new ProjectBoundaryError(
          "A project workspace cannot move after a session has been bound.",
          { projectId: id }
        );
      }
      if (nextWorkspaceRoot !== current.workspaceRoot) {
        this._assertWorkspaceDisjoint(id, nextWorkspaceRoot);
      }

      const at = this._now();
      const next = normalizeStoredProject({
        ...current,
        name: source.name === undefined
          ? current.name
          : requiredText(source.name, "name", 200),
        workspaceRoot: nextWorkspaceRoot,
        instructions: source.instructions === undefined
          ? current.instructions
          : normalizeInstructions(source.instructions),
        secretRefs: source.secretRefs === undefined
          ? current.secretRefs
          : normalizeSecretRefs(source.secretRefs),
        activeSkills: source.activeSkills === undefined
          ? current.activeSkills
          : normalizeSkillRefs(source.activeSkills),
        modelProfile: source.modelProfile === undefined
          ? current.modelProfile
          : normalizeProfile(source.modelProfile, "modelProfile"),
        routingProfile: source.routingProfile === undefined
          ? current.routingProfile
          : normalizeProfile(source.routingProfile, "routingProfile"),
        mcpGrants: source.mcpGrants === undefined
          ? current.mcpGrants
          : normalizeCapabilityList(source.mcpGrants, "mcpGrants"),
        policy: source.policy === undefined
          ? current.policy
          : normalizeProjectPolicy(source.policy),
        hookIds: source.hookIds === undefined
          ? current.hookIds
          : normalizeCapabilityList(source.hookIds, "hookIds"),
        scheduleIds: source.scheduleIds === undefined
          ? current.scheduleIds
          : normalizeCapabilityList(source.scheduleIds, "scheduleIds"),
        kanbanBoardId: source.kanbanBoardId === undefined
          ? current.kanbanBoardId
          : normalizeCapabilityName(source.kanbanBoardId, "kanbanBoardId"),
        artifactIds: source.artifactIds === undefined
          ? current.artifactIds
          : normalizeCapabilityList(source.artifactIds, "artifactIds"),
        recipeIds: source.recipeIds === undefined
          ? current.recipeIds
          : normalizeCapabilityList(source.recipeIds, "recipeIds"),
        revision: current.revision + 1,
        updatedAt: at,
        updatedBy: normalizeActor(contextValues)
      });
      this.projects.set(id, next);
      this._commit("update", id, { revision: next.revision });
      return this._view(next);
    });
  }

  archive(projectId, context = {}) {
    const contextValues = plainDataRecord(context, "archive context");
    const id = normalizeProjectId(projectId);
    if (id === DEFAULT_PROJECT_ID) {
      throw new ProjectBoundaryError("The default project cannot be archived.");
    }
    return this._runMutation(() => {
      const current = this._requireProject(id);
      assertExpectedRevision(current, contextValues.expectedRevision);
      if (current.status === PROJECT_STATUSES.ARCHIVED) return this._view(current);
      if (current.revision >= Number.MAX_SAFE_INTEGER) {
        throw new RangeError("Project revision limit reached.");
      }
      const at = this._now();
      const next = {
        ...current,
        status: PROJECT_STATUSES.ARCHIVED,
        revision: current.revision + 1,
        updatedAt: at,
        archivedAt: at,
        updatedBy: normalizeActor(contextValues)
      };
      this.projects.set(id, next);
      if (this.selectedProjectId === id) this.selectedProjectId = DEFAULT_PROJECT_ID;
      this._commit("archive", id, { revision: next.revision });
      return this._view(next);
    });
  }

  select(projectId, context = {}) {
    const contextValues = plainDataRecord(context, "select context");
    return this._runMutation(() => {
      const project = this._requireProject(projectId, { active: true });
      if (this.selectedProjectId === project.id) return this._view(project);
      this.selectedProjectId = project.id;
      this._commit("select", project.id, { selectedBy: normalizeActor(contextValues) });
      return this._view(project);
    });
  }

  resolveForSession(sessionId, options = {}) {
    const {
      requestedProjectId = null,
      legacySession = false,
      bind = true,
      actor = "runtime"
    } = plainDataRecord(options, "session resolution options");
    requireBoolean(legacySession, "legacySession");
    requireBoolean(bind, "bind");
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (requestedProjectId != null && typeof requestedProjectId !== "string") {
      throw new TypeError("requestedProjectId must be a string.");
    }
    const requested = requestedProjectId == null || requestedProjectId.trim() === ""
      ? null
      : normalizeProjectId(requestedProjectId);
    return this._runMutation(() => {
      const boundId = this.sessionProjects.get(normalizedSessionId) ?? null;
      if (boundId) {
        if (requested && requested !== boundId) {
          throw new ProjectBoundaryError(
            `Session '${normalizedSessionId}' belongs to project '${boundId}', not '${requested}'.`,
            {
              sessionId: normalizedSessionId,
              projectId: boundId,
              requestedProjectId: requested
            }
          );
        }
        return this._view(this._requireProject(boundId, { active: true }));
      }

      // Missing selection always means the backward-compatible default. A
      // process-global UI preference must never decide another client's scope.
      if (legacySession && requested && requested !== DEFAULT_PROJECT_ID) {
        throw new ProjectBoundaryError(
          `Legacy session '${normalizedSessionId}' belongs to the default project.`,
          {
            sessionId: normalizedSessionId,
            projectId: DEFAULT_PROJECT_ID,
            requestedProjectId: requested
          }
        );
      }
      const targetId = legacySession
        ? DEFAULT_PROJECT_ID
        : requested ?? DEFAULT_PROJECT_ID;
      const project = this._requireProject(targetId, { active: true });
      if (bind) {
        if (this.sessionProjects.size >= MAX_SESSION_BINDINGS) {
          throw new RangeError(`Session binding limit reached (${MAX_SESSION_BINDINGS}).`);
        }
        this.sessionProjects.set(normalizedSessionId, project.id);
        this._commit("bind-session", project.id, {
          sessionId: normalizedSessionId,
          actor: normalizeActor({ actor })
        });
      }
      return this._view(project);
    });
  }

  projectForSession(sessionId, options = {}) {
    const { includeArchived = false } = plainDataRecord(options, "session lookup options");
    requireBoolean(includeArchived, "includeArchived");
    if (sessionId == null || sessionId === "") return null;
    const normalizedSessionId = normalizeSessionId(sessionId);
    const id = this.sessionProjects.get(normalizedSessionId) ?? DEFAULT_PROJECT_ID;
    return this.get(id, { includeArchived });
  }

  hasSessionBinding(sessionId) {
    if (sessionId == null || sessionId === "") return false;
    return this.sessionProjects.has(normalizeSessionId(sessionId));
  }

  unbindSession(projectId, sessionId, context = {}) {
    const expected = normalizeProjectId(projectId);
    const normalizedSessionId = normalizeSessionId(sessionId);
    const contextValues = plainDataRecord(context, "session unbind context");
    return this._runMutation(() => {
      this._requireProject(expected);
      const actual = this.sessionProjects.get(normalizedSessionId) ?? null;
      if (actual === null) return false;
      if (actual !== expected) {
        throw new ProjectBoundaryError(
          `Session '${normalizedSessionId}' is outside project '${expected}'.`,
          {
            projectId: expected,
            sessionId: normalizedSessionId,
            actualProjectId: actual
          }
        );
      }
      this.sessionProjects.delete(normalizedSessionId);
      this._commit("unbind-session", expected, {
        sessionId: normalizedSessionId,
        actor: normalizeActor(contextValues)
      });
      return true;
    });
  }

  sessionsForProject(projectId) {
    const id = normalizeProjectId(projectId);
    return [...this.sessionProjects.entries()]
      .filter(([, candidate]) => candidate === id)
      .map(([sessionId]) => sessionId)
      .sort();
  }

  assertSession(projectId, sessionId) {
    const expected = normalizeProjectId(projectId);
    const normalizedSessionId = normalizeSessionId(sessionId);
    const actual = this.sessionProjects.get(normalizedSessionId)
      ?? DEFAULT_PROJECT_ID;
    if (actual !== expected) {
      throw new ProjectBoundaryError(
        `Session '${normalizedSessionId}' is outside project '${expected}'.`,
        { projectId: expected, sessionId: normalizedSessionId, actualProjectId: actual }
      );
    }
    return true;
  }

  attachResource(projectId, field, resourceId, context = {}) {
    if (!RESOURCE_FIELDS.has(field)) {
      throw new TypeError(`Unsupported project resource field: ${field}`);
    }
    const normalized = normalizeCapabilityName(resourceId, field);
    const contextValues = plainDataRecord(context, "resource context");
    return this._runMutation(() => {
      const project = this._requireProject(projectId, { active: true });
      if (project[field].includes(normalized)) return this._view(project);
      const next = normalizeStoredProject({
        ...project,
        [field]: [...project[field], normalized],
        updatedAt: this._now(),
        updatedBy: normalizeActor(contextValues)
      });
      this.projects.set(project.id, next);
      this._commit("attach-resource", project.id, {
        field,
        resourceId: normalized
      });
      return this._view(next);
    });
  }

  detachResource(projectId, field, resourceId, context = {}) {
    if (!RESOURCE_FIELDS.has(field)) {
      throw new TypeError(`Unsupported project resource field: ${field}`);
    }
    const normalized = normalizeCapabilityName(resourceId, field);
    const contextValues = plainDataRecord(context, "resource context");
    return this._runMutation(() => {
      const project = this._requireProject(projectId, { active: true });
      if (!project[field].includes(normalized)) return this._view(project);
      const next = normalizeStoredProject({
        ...project,
        [field]: project[field].filter((item) => item !== normalized),
        updatedAt: this._now(),
        updatedBy: normalizeActor(contextValues)
      });
      this.projects.set(project.id, next);
      this._commit("detach-resource", project.id, {
        field,
        resourceId: normalized
      });
      return this._view(next);
    });
  }

  allowsTool(projectId, toolName) {
    const project = this._authorizeActiveProject(projectId);
    return allowsWildcard(project.policy.allowedTools, toolName);
  }

  allowsMcp(projectId, serverName) {
    const project = this._authorizeActiveProject(projectId);
    return allowsWildcard(project.mcpGrants, serverName);
  }

  allowsSkill(projectId, skillName) {
    const project = this._authorizeActiveProject(projectId);
    return allowsWildcard(project.activeSkills, skillName);
  }

  allowsSecret(projectId, secretName) {
    const project = this._authorizeActiveProject(projectId);
    return allowsWildcard(project.secretRefs, secretName);
  }

  resolveWorkspacePath(projectId, candidate = ".") {
    const project = this._authorizeActiveProject(projectId);
    const relative = candidate == null ? "." : requiredText(candidate, "workspace path", 4096);
    const target = path.resolve(project.workspaceRoot, relative);
    assertPathWithin(target, project.workspaceRoot);
    const realTarget = resolveRealCandidate(target);
    const realRoot = resolveRealCandidate(project.workspaceRoot);
    if (!realTarget || !realRoot) {
      throw new ProjectBoundaryError("Project workspace path cannot be resolved.", {
        projectId: project.id
      });
    }
    assertPathWithin(realTarget, realRoot);
    return target;
  }

  _ensureDefaultProject() {
    const existing = this.projects.get(DEFAULT_PROJECT_ID);
    if (existing) {
      if (existing.workspaceRoot !== this.defaultWorkspaceRoot) {
        // The persisted root is authoritative after first boot. Moving it
        // implicitly would reinterpret every legacy session.
        this.defaultWorkspaceRoot = existing.workspaceRoot;
      }
      return;
    }
    const at = this._now();
    const project = normalizeStoredProject({
      version: 1,
      id: DEFAULT_PROJECT_ID,
      name: "Default",
      status: PROJECT_STATUSES.ACTIVE,
      revision: 1,
      workspaceRoot: this.defaultWorkspaceRoot,
      instructions: "",
      memoryScope: "main",
      secretRefs: ["*"],
      activeSkills: ["*"],
      modelProfile: {},
      routingProfile: {},
      mcpGrants: ["*"],
      policy: {
        toolPolicy: "full",
        allowedTools: ["*"]
      },
      hookIds: ["*"],
      scheduleIds: [],
      kanbanBoardId: "default",
      artifactIds: [],
      recipeIds: [],
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      createdBy: "runtime:migration",
      updatedBy: "runtime:migration"
    });
    this.projects.set(DEFAULT_PROJECT_ID, project);
    this.selectedProjectId = DEFAULT_PROJECT_ID;
    this._commit("create-default", DEFAULT_PROJECT_ID, {
      migratedLegacySessions: true
    });
  }

  _managedWorkspaceRoot(projectId, requested) {
    const value = requested == null
      ? ""
      : requiredText(requested, "workspaceRoot", 4096);
    const candidate = value === ""
      ? path.join(this.workspaceBase, projectId)
      : path.isAbsolute(value)
        ? path.resolve(value)
        : path.resolve(this.workspaceBase, value);
    assertPathWithin(candidate, this.workspaceBase);
    const realBase = resolveRealCandidate(this.workspaceBase);
    const prospectiveCandidate = resolveRealCandidate(candidate);
    if (!realBase || !prospectiveCandidate) {
      throw new ProjectBoundaryError("Project workspace root cannot be resolved.");
    }
    assertPathWithin(prospectiveCandidate, realBase);
    this._assertWorkspaceDisjoint(projectId, prospectiveCandidate);
    ensureDir(candidate);
    const realCandidate = resolveRealCandidate(candidate);
    if (!realCandidate) {
      throw new ProjectBoundaryError("Project workspace root cannot be resolved.");
    }
    assertPathWithin(realCandidate, realBase);
    return candidate;
  }

  _assertWorkspaceDisjoint(projectId, workspaceRoot) {
    const candidate = resolveRealCandidate(workspaceRoot) ?? path.resolve(workspaceRoot);
    for (const project of this.projects.values()) {
      if (project.id === projectId) continue;
      const existing = resolveRealCandidate(project.workspaceRoot)
        ?? path.resolve(project.workspaceRoot);
      if (pathsOverlap(candidate, existing)) {
        throw new ProjectBoundaryError(
          `Project workspace overlaps project '${project.id}'.`,
          { projectId, conflictingProjectId: project.id }
        );
      }
    }
  }

  _uniqueProjectId(base) {
    if (!this.projects.has(base) && base !== DEFAULT_PROJECT_ID) return base;
    for (let suffix = 2; suffix <= MAX_PROJECTS + 1; suffix += 1) {
      const candidate = `${base.slice(0, Math.max(1, 63 - String(suffix).length - 1))}-${suffix}`;
      if (!this.projects.has(candidate) && candidate !== DEFAULT_PROJECT_ID) return candidate;
    }
    throw new Error("Unable to allocate a unique project id.");
  }

  _requireProject(projectId, { active = false } = {}) {
    const id = normalizeProjectId(projectId);
    const project = this.projects.get(id);
    if (!project) throw new Error(`Unknown project: ${id}`);
    if (active && project.status !== PROJECT_STATUSES.ACTIVE) {
      throw new ProjectBoundaryError(`Project '${id}' is archived.`, {
        projectId: id
      });
    }
    return project;
  }

  _authorizeActiveProject(projectId) {
    const id = normalizeProjectId(projectId);
    const project = this.authorize(id, { includeArchived: true });
    if (!project) throw new Error(`Unknown project: ${id}`);
    if (project.status !== PROJECT_STATUSES.ACTIVE) {
      throw new ProjectBoundaryError(`Project '${id}' is archived.`, {
        projectId: id
      });
    }
    return project;
  }

  _view(project) {
    if (!project) return null;
    return structuredClone({
      ...project,
      selected: project.id === this.selectedProjectId,
      sessionIds: this.sessionsForProject(project.id)
    });
  }

  _runMutation(operation) {
    if (typeof operation !== "function") {
      throw new TypeError("Project mutation must be a function.");
    }
    const outermost = this.lockDepth === 0;
    let result;
    let failure = null;
    let changes = [];
    try {
      result = this._withMutationLock(() => {
        if (outermost) {
          // Every process validates and mutates the latest authoritative
          // event-backed state while it owns the same filesystem lock.
          this._restoreDurableState();
          this.mutationChanges = [];
        }
        return operation();
      });
    } catch (error) {
      failure = error;
    } finally {
      if (outermost) {
        changes = this.mutationChanges ?? [];
        this.mutationChanges = null;
      }
    }
    if (outermost) {
      for (const change of changes) this._notifyChange(change);
    }
    if (failure) throw failure;
    return result;
  }

  _withMutationLock(operation) {
    if (this.lockDepth > 0) {
      this.lockDepth += 1;
      try {
        return operation();
      } finally {
        this.lockDepth -= 1;
      }
    }

    ensureDir(this.dir);
    const token = JSON.stringify({
      pid: process.pid,
      createdAt: Date.now(),
      nonce: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    });
    const deadline = Date.now() + this.lockTimeoutMs;
    let acquired = false;
    while (!acquired) {
      let fd;
      try {
        fd = fs.openSync(this.lockPath, "wx", 0o600);
        fs.writeFileSync(fd, token, "utf8");
        fs.fsyncSync(fd);
        acquired = true;
      } catch (error) {
        if (error?.code !== "EEXIST") {
          if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* best effort */ }
            fd = undefined;
            try { fs.unlinkSync(this.lockPath); } catch { /* best effort */ }
          }
          throw error;
        }
        if (!this._breakStaleMutationLock() && Date.now() >= deadline) {
          throw new Error("Project store is busy.");
        }
        if (!acquired) waitSynchronously(PROJECT_LOCK_RETRY_MS);
      } finally {
        try { if (fd !== undefined) fs.closeSync(fd); } catch { /* best effort */ }
      }
    }

    this.lockDepth = 1;
    try {
      return operation();
    } finally {
      this.lockDepth = 0;
      this._releaseMutationLock(token);
    }
  }

  _breakStaleMutationLock() {
    let stat;
    let content;
    try {
      stat = fs.lstatSync(this.lockPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      if (Date.now() - stat.mtimeMs < this.staleLockMs) return false;
      content = fs.readFileSync(this.lockPath, "utf8");
    } catch {
      return false;
    }
    let owner;
    try { owner = JSON.parse(content); } catch { owner = null; }
    if (processIsAlive(owner?.pid)) return false;
    try {
      if (fs.readFileSync(this.lockPath, "utf8") !== content) return false;
      fs.unlinkSync(this.lockPath);
      return true;
    } catch {
      return false;
    }
  }

  _releaseMutationLock(token) {
    try {
      if (fs.readFileSync(this.lockPath, "utf8") === token) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      // Never delete a lock whose ownership token cannot be verified.
    }
  }

  _notifyChange(change) {
    try {
      this.onChange?.(structuredClone(change));
    } catch {
      // Project persistence is authoritative; observer delivery is advisory.
    }
  }

  _commit(op, projectId, details = {}) {
    if (this.lockDepth < 1 || !Array.isArray(this.mutationChanges)) {
      throw new Error("Project commits require the mutation lock.");
    }
    const at = this._now();
    const sequence = this.sequence + 1;
    const state = this._state(at, sequence);
    const event = {
      version: 1,
      sequence,
      op,
      at,
      projectId,
      details,
      state
    };
    if (
      jsonByteLength(state) > MAX_STATE_BYTES
      || jsonByteLength(event) > MAX_EVENT_LINE_BYTES
    ) {
      this._restoreDurableState();
      throw new RangeError("Project state exceeds its durable persistence bound.");
    }
    let appendFailed = null;
    try {
      this.appendEvent(this.eventsPath, event);
    } catch (error) {
      appendFailed = error;
      // Callers stage their mutation in memory before entering _commit. If the
      // authoritative append fails, rebuild from the last durable state so a
      // failed write can never leave a live-only project or binding behind.
      this._restoreDurableState();
      const durableState = this._state(state.updatedAt, this.sequence);
      if (
        this.sequence !== sequence
        || !statesEquivalent(durableState, state)
      ) {
        throw error;
      }
    }
    if (!appendFailed) this.sequence = sequence;
    try {
      this.writeSnapshot(this.snapshotPath, state);
    } catch (error) {
      // The JSONL event is authoritative and will repair the snapshot at the
      // next successful mutation or restart. Do not report a committed change
      // as failed merely because its cache snapshot could not be refreshed.
      console.warn(`[projects] snapshot refresh failed: ${error?.message ?? error}`);
    }
    this.mutationChanges.push({ op, at, projectId, details });
  }

  _restoreDurableState() {
    this.projects = new Map();
    this.sessionProjects = new Map();
    this.selectedProjectId = DEFAULT_PROJECT_ID;
    this.sequence = 0;
    this._loadSnapshot();
    this._replayEvents();
  }

  _state(at = this._now(), sequence = this.sequence) {
    return {
      version: 1,
      sequence,
      updatedAt: at,
      selectedProjectId: this.selectedProjectId,
      projects: [...this.projects.values()].map((project) => structuredClone(project)),
      sessionBindings: [...this.sessionProjects.entries()]
        .map(([sessionId, projectId]) => ({ sessionId, projectId }))
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
    };
  }

  _loadSnapshot() {
    let snapshot;
    try {
      if (fs.statSync(this.snapshotPath).size > MAX_SNAPSHOT_BYTES) return;
      snapshot = readJsonFile(this.snapshotPath, null);
    } catch (error) {
      if (error.code === "ENOENT") return;
      return;
    }
    if (!validStoredState(snapshot)) return;
    try {
      this._applyState(snapshot);
    } catch {
      // Invalid workspace topology or corrupt state fails closed.
    }
  }

  _replayEvents() {
    let lines;
    try {
      lines = readEventTail(this.eventsPath);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE_BYTES) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        event?.version !== 1
        || !Number.isSafeInteger(event?.sequence)
        || event.sequence <= this.sequence
        || !validStoredState(event.state)
        || event.state.sequence !== event.sequence
        || typeof event.op !== "string"
        || !EVENT_OP_RE.test(event.op)
        || typeof event.projectId !== "string"
        || !event.state.projects.some((project) => project.id === event.projectId)
        || requiredIsoOrNull(event.at) == null
        || event.state.updatedAt !== event.at
      ) {
        continue;
      }
      try {
        this._applyState(event.state);
      } catch {
        // Ignore a corrupt or out-of-bound full-state event.
      }
    }
  }

  _applyState(state) {
    const projects = new Map();
    for (const raw of state.projects) {
      const project = normalizeStoredProject(raw);
      projects.set(project.id, project);
    }
    this._validateProjectWorkspaces(projects);
    const bindings = new Map();
    for (const binding of state.sessionBindings) {
      bindings.set(binding.sessionId, binding.projectId);
    }
    this.projects = projects;
    this.sessionProjects = bindings;
    this.selectedProjectId = projects.has(state.selectedProjectId)
      ? state.selectedProjectId
      : DEFAULT_PROJECT_ID;
    this.sequence = state.sequence;
  }

  _validateProjectWorkspaces(projects) {
    const realBase = resolveRealCandidate(this.workspaceBase);
    if (!realBase) {
      throw new ProjectBoundaryError("Managed project workspace base cannot be resolved.");
    }
    const roots = [];
    for (const project of projects.values()) {
      if (project.id === DEFAULT_PROJECT_ID) {
        if (project.status !== PROJECT_STATUSES.ACTIVE) {
          throw new ProjectBoundaryError("The default project must remain active.");
        }
      } else {
        assertPathWithin(project.workspaceRoot, this.workspaceBase);
        const managedRoot = resolveRealCandidate(project.workspaceRoot);
        if (!managedRoot) {
          throw new ProjectBoundaryError(
            `Workspace for project '${project.id}' cannot be resolved.`
          );
        }
        assertPathWithin(managedRoot, realBase);
      }
      const resolved = resolveRealCandidate(project.workspaceRoot);
      if (!resolved || !isDirectoryOrMissingTail(project.workspaceRoot)) {
        throw new ProjectBoundaryError(
          `Workspace for project '${project.id}' is not a directory.`
        );
      }
      for (const previous of roots) {
        if (pathsOverlap(resolved, previous.root)) {
          throw new ProjectBoundaryError(
            `Project workspace overlaps project '${previous.projectId}'.`,
            {
              projectId: project.id,
              conflictingProjectId: previous.projectId
            }
          );
        }
      }
      roots.push({ projectId: project.id, root: resolved });
    }
  }

  _now() {
    const value = this.now();
    if (value instanceof Date) return value.toISOString();
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? nowIso() : parsed.toISOString();
  }
}

export function projectMemoryScope(project, specialistId = null) {
  if (!project || typeof project !== "object") return "main";
  const source = plainDataRecord(project, "project");
  if (specialistId != null && typeof specialistId !== "string") {
    throw new TypeError("specialistId must be a string.");
  }
  const specialist = (specialistId ?? "").trim();
  if (source.id === DEFAULT_PROJECT_ID) {
    return specialist ? `specialist:${specialist}` : "main";
  }
  const base = `project:${normalizeProjectId(source.id)}`;
  return specialist ? `${base}:specialist:${specialist}` : base;
}

export function projectAllows(list, value) {
  if (!Array.isArray(list) || utilTypes.isProxy(list)) return false;
  try {
    return allowsWildcard(plainDataArray(list, "capability list"), value);
  } catch {
    return false;
  }
}

function validStoredState(state) {
  try {
    const source = plainDataRecord(state, "stored project state");
    assertOnlyKeys(source, STORED_STATE_FIELDS, "stored project state");
    if (
      source.version !== 1
      || !Number.isSafeInteger(source.sequence)
      || source.sequence < 0
      || typeof source.selectedProjectId !== "string"
      || requiredIsoOrNull(source.updatedAt) == null
    ) {
      return false;
    }
    const projectRecords = plainDataArray(
      source.projects,
      "stored projects",
      MAX_PROJECTS
    );
    const bindingRecords = plainDataArray(
      source.sessionBindings,
      "stored session bindings",
      MAX_SESSION_BINDINGS
    );
    if (projectRecords.length < 1) return false;
    const ids = new Set();
    for (const raw of projectRecords) {
      const project = normalizeStoredProject(raw);
      if (ids.has(project.id)) return false;
      ids.add(project.id);
    }
    if (!ids.has(DEFAULT_PROJECT_ID) || !ids.has(normalizeProjectId(source.selectedProjectId))) {
      return false;
    }
    const sessions = new Set();
    for (const raw of bindingRecords) {
      const binding = plainDataRecord(raw, "session binding");
      assertOnlyKeys(binding, new Set(["projectId", "sessionId"]), "session binding");
      const sessionId = normalizeSessionId(binding.sessionId);
      const projectId = normalizeProjectId(binding.projectId);
      if (sessions.has(sessionId) || !ids.has(projectId)) return false;
      sessions.add(sessionId);
    }
    return true;
  } catch {
    return false;
  }
}

function normalizeStoredProject(raw) {
  const source = plainDataRecord(raw, "stored project");
  assertOnlyKeys(source, STORED_PROJECT_FIELDS, "stored project");
  if (source.version !== 1) throw new TypeError("Invalid stored project version.");
  const id = normalizeProjectId(source.id);
  const status = source.status;
  if (!Object.values(PROJECT_STATUSES).includes(status)) {
    throw new TypeError(`Invalid project status: ${status}`);
  }
  if (!Number.isSafeInteger(source.revision) || source.revision < 1) {
    throw new TypeError("Invalid project revision.");
  }
  const rawWorkspaceRoot = requiredText(source.workspaceRoot, "workspaceRoot", 4096);
  if (!path.isAbsolute(rawWorkspaceRoot)) {
    throw new TypeError("workspaceRoot must be absolute.");
  }
  const workspaceRoot = path.resolve(rawWorkspaceRoot);
  const createdAt = requiredIso(source.createdAt, "createdAt");
  const updatedAt = requiredIso(source.updatedAt, "updatedAt");
  const archivedAt = source.archivedAt == null
    ? null
    : requiredIso(source.archivedAt, "archivedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new TypeError("updatedAt cannot precede createdAt.");
  }
  if (
    (status === PROJECT_STATUSES.ARCHIVED && archivedAt == null)
    || (status === PROJECT_STATUSES.ACTIVE && archivedAt != null)
  ) {
    throw new TypeError("Project status and archivedAt are inconsistent.");
  }
  if (archivedAt != null && Date.parse(archivedAt) < Date.parse(createdAt)) {
    throw new TypeError("archivedAt cannot precede createdAt.");
  }
  const expectedMemoryScope = id === DEFAULT_PROJECT_ID ? "main" : `project:${id}`;
  if (source.memoryScope !== expectedMemoryScope) {
    throw new TypeError("Project memoryScope does not match its id.");
  }
  return {
    version: 1,
    id,
    name: requiredText(source.name, "name", 200),
    status,
    revision: source.revision,
    workspaceRoot,
    instructions: normalizeInstructions(source.instructions),
    memoryScope: expectedMemoryScope,
    secretRefs: normalizeSecretRefs(source.secretRefs),
    activeSkills: normalizeSkillRefs(source.activeSkills),
    modelProfile: normalizeProfile(source.modelProfile, "modelProfile"),
    routingProfile: normalizeProfile(source.routingProfile, "routingProfile"),
    mcpGrants: normalizeCapabilityList(source.mcpGrants, "mcpGrants"),
    policy: normalizeProjectPolicy(source.policy),
    hookIds: normalizeCapabilityList(source.hookIds, "hookIds"),
    scheduleIds: normalizeCapabilityList(source.scheduleIds, "scheduleIds"),
    kanbanBoardId: normalizeCapabilityName(source.kanbanBoardId, "kanbanBoardId"),
    artifactIds: normalizeCapabilityList(source.artifactIds, "artifactIds"),
    recipeIds: normalizeCapabilityList(source.recipeIds, "recipeIds"),
    createdAt,
    updatedAt,
    archivedAt,
    createdBy: optionalText(source.createdBy, 200) ?? "unknown",
    updatedBy: optionalText(source.updatedBy, 200) ?? "unknown"
  };
}

function normalizeProjectPolicy(value) {
  const source = value == null ? {} : plainDataRecord(value, "policy");
  assertOnlyKeys(source, new Set(["allowedTools", "toolPolicy"]), "policy");
  const toolPolicy = optionalText(source.toolPolicy, 32) ?? "full";
  if (!TOOL_POLICIES.has(toolPolicy)) {
    throw new TypeError("policy.toolPolicy must be full, confirm, read-only, or none.");
  }
  return {
    toolPolicy,
    allowedTools: normalizeCapabilityList(source.allowedTools, "policy.allowedTools")
  };
}

function normalizeProfile(value, field) {
  if (value == null) return {};
  return normalizeProfileValue(value, field, 0, { chars: 0, nodes: 0 });
}

function normalizeProfileValue(value, field, depth, budget) {
  if (depth > MAX_PROFILE_DEPTH) {
    throw new RangeError(`${field} exceeds the maximum depth.`);
  }
  budget.nodes += 1;
  if (budget.nodes > MAX_PROFILE_NODES) {
    throw new RangeError(`${field} has too many values.`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 2000) throw new RangeError(`${field} contains an oversized string.`);
    budget.chars += value.length;
    if (budget.chars > MAX_PROFILE_CHARS) {
      throw new RangeError(`${field} contains too much text.`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${field} contains a non-finite number.`);
    return value;
  }
  if (utilTypes.isProxy(value)) {
    throw new TypeError(`${field} must contain plain JSON values.`);
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_LIST_ITEMS) throw new RangeError(`${field} is too large.`);
    const values = plainDataArray(value, field);
    return values.map((item, index) => (
      normalizeProfileValue(item, `${field}[${index}]`, depth + 1, budget)
    ));
  }
  if (
    !value
    || typeof value !== "object"
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${field} must contain plain JSON values.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries = Object.entries(descriptors);
  if (entries.length > MAX_PROFILE_KEYS) throw new RangeError(`${field} has too many keys.`);
  const result = {};
  for (const [key, descriptor] of entries) {
    if (!CAPABILITY_NAME_RE.test(key)) throw new TypeError(`${field} contains an invalid key.`);
    if (SENSITIVE_PROFILE_KEY.test(key)) {
      throw new TypeError(`${field} cannot contain credential-bearing fields.`);
    }
    if (!Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${field} cannot contain accessors.`);
    }
    budget.chars += key.length;
    if (budget.chars > MAX_PROFILE_CHARS) {
      throw new RangeError(`${field} contains too much text.`);
    }
    result[key] = normalizeProfileValue(
      descriptor.value,
      `${field}.${key}`,
      depth + 1,
      budget
    );
  }
  return result;
}

function normalizeSecretRefs(value) {
  if (value == null) return [];
  return normalizeList(value, "secretRefs", (item) => {
    const text = requiredText(item, "secret reference", 128);
    if (text === "*") return text;
    if (!SECRET_NAME_RE.test(text)) throw new TypeError(`Invalid secret reference: ${text}`);
    return text;
  });
}

function normalizeSkillRefs(value) {
  if (value == null) return [];
  return normalizeList(value, "activeSkills", (item) => {
    const text = requiredText(item, "skill reference", 128);
    if (text === "*") return text;
    if (!SKILL_NAME_RE.test(text)) throw new TypeError(`Invalid skill reference: ${text}`);
    return text;
  });
}

function normalizeCapabilityList(value, field) {
  if (value == null) return [];
  return normalizeList(value, field, (item) => normalizeCapabilityName(item, field));
}

function normalizeList(value, field, normalizeItem) {
  const values = plainDataArray(value, field);
  if (values.length > MAX_LIST_ITEMS) throw new RangeError(`${field} is too large.`);
  return [...new Set(values.map(normalizeItem))].sort();
}

function normalizeCapabilityName(value, field) {
  const text = requiredText(value, field, 128);
  if (text === "*") return text;
  if (!CAPABILITY_NAME_RE.test(text)) throw new TypeError(`Invalid ${field} value: ${text}`);
  return text;
}

function normalizeInstructions(value) {
  if (value == null) return "";
  if (typeof value !== "string") throw new TypeError("instructions must be a string.");
  const text = value;
  if (text.length > MAX_INSTRUCTIONS_CHARS) {
    throw new RangeError(`instructions exceeds ${MAX_INSTRUCTIONS_CHARS} characters.`);
  }
  return text;
}

function normalizeProjectId(value) {
  if (typeof value !== "string") throw new TypeError("project id must be a string.");
  const id = value.trim().toLowerCase();
  if (!PROJECT_ID_RE.test(id)) throw new TypeError(`Invalid project id: ${id || "(empty)"}`);
  return id;
}

function slugProjectName(value) {
  const slug = value
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return PROJECT_ID_RE.test(slug) ? slug : "project";
}

function requiredText(value, field, maxLength) {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string.`);
  const text = value.trim();
  if (!text) throw new TypeError(`${field} is required.`);
  if (text.length > maxLength) throw new RangeError(`${field} is too long.`);
  return text;
}

function optionalText(value, maxLength) {
  if (value == null) return null;
  if (typeof value !== "string") throw new TypeError("value must be a string.");
  const text = value.trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

function requiredIso(value, field) {
  const text = requiredText(value, field, 64);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${field} must be an ISO timestamp.`);
  return parsed.toISOString();
}

function requiredIsoOrNull(value) {
  try {
    return requiredIso(value, "timestamp");
  } catch {
    return null;
  }
}

function normalizeActor(context) {
  const source = plainDataRecord(context, "actor context");
  return optionalText(
    source.actor
    ?? source.decidedBy
    ?? source.from
    ?? source.agentId
    ?? "runtime",
    200
  ) ?? "runtime";
}

function assertExpectedRevision(project, expectedRevision) {
  if (expectedRevision == null) return;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new TypeError("expectedRevision must be a positive integer.");
  }
  if (project.revision !== expectedRevision) {
    throw new ProjectRevisionError(project.id, expectedRevision, project.revision);
  }
}

function allowsWildcard(values, candidate) {
  if (typeof candidate !== "string") return false;
  const name = candidate.trim();
  return Boolean(name && (values.includes("*") || values.includes(name)));
}

function normalizeSessionId(value) {
  if (typeof value !== "string") throw new TypeError("sessionId must be a string.");
  const id = value.trim();
  if (
    id.length > MAX_SESSION_ID_CHARS
    || !SESSION_ID_RE.test(id)
  ) {
    throw new TypeError("sessionId must contain only printable ASCII characters.");
  }
  return id;
}

function requireBoolean(value, field) {
  if (typeof value !== "boolean") throw new TypeError(`${field} must be a boolean.`);
  return value;
}

function plainDataRecord(value, field) {
  if (
    !value
    || typeof value !== "object"
    || utilTypes.isProxy(value)
    || Array.isArray(value)
  ) {
    throw new TypeError(`${field} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must be a plain object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      throw new TypeError(`${field} cannot contain symbol keys.`);
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${field} cannot contain hidden fields or accessors.`);
    }
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: descriptor.value,
      writable: true
    });
  }
  return result;
}

function plainDataArray(value, field, maxItems = MAX_LIST_ITEMS) {
  if (
    !Array.isArray(value)
    || utilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new TypeError(`${field} must be a plain array.`);
  }
  if (value.length > maxItems) {
    throw new RangeError(`${field} is too large.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  for (const key of keys) {
    if (typeof key !== "string") {
      throw new TypeError(`${field} cannot contain symbol keys.`);
    }
    if (key === "length") continue;
    if (!/^(?:0|[1-9][0-9]*)$/.test(key)) {
      throw new TypeError(`${field} cannot contain custom properties.`);
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${field} cannot contain accessors.`);
    }
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${field} cannot contain sparse entries.`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function assertOnlyKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`Unsupported ${field} field: ${key}`);
  }
}

function statesEquivalent(left, right) {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function jsonByteLength(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Project state is not JSON serializable.");
  }
  return Buffer.byteLength(serialized, "utf8");
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function waitSynchronously(milliseconds) {
  Atomics.wait(
    PROJECT_LOCK_WAIT_BUFFER,
    0,
    0,
    Math.max(1, milliseconds)
  );
}

function readEventTail(filePath) {
  const stat = fs.statSync(filePath);
  const length = Math.min(stat.size, MAX_EVENT_REPLAY_BYTES);
  const offset = stat.size - length;
  const buffer = Buffer.allocUnsafe(length);
  const fd = fs.openSync(filePath, "r");
  let bytesRead = 0;
  try {
    while (bytesRead < length) {
      const count = fs.readSync(
        fd,
        buffer,
        bytesRead,
        length - bytesRead,
        offset + bytesRead
      );
      if (count === 0) break;
      bytesRead += count;
    }
  } finally {
    fs.closeSync(fd);
  }
  let text = buffer.subarray(0, bytesRead).toString("utf8");
  if (offset > 0) {
    const firstNewline = text.indexOf("\n");
    text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
  }
  return text.split(/\r?\n/u);
}

function isDirectoryOrMissingTail(value) {
  const target = path.resolve(value);
  try {
    return fs.statSync(target).isDirectory();
  } catch (error) {
    if (error.code !== "ENOENT") return false;
    let probe = path.dirname(target);
    while (probe !== path.dirname(probe)) {
      try {
        return fs.statSync(probe).isDirectory();
      } catch (nested) {
        if (nested.code !== "ENOENT") return false;
      }
      probe = path.dirname(probe);
    }
    return false;
  }
}

function assertPathWithin(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (
    relative !== ""
    && (
      relative === ".."
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)
    )
  ) {
    throw new ProjectBoundaryError("Path is outside the project workspace.", {
      path: path.resolve(candidate),
      workspaceRoot: path.resolve(root)
    });
  }
}

function pathsOverlap(left, right) {
  try {
    assertPathWithin(left, right);
    return true;
  } catch {
    // Check the inverse below.
  }
  try {
    assertPathWithin(right, left);
    return true;
  } catch {
    return false;
  }
}

function resolveRealCandidate(candidate) {
  let probe = path.resolve(candidate);
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return null;
    probe = parent;
  }
  let real;
  try {
    real = fs.realpathSync(probe);
  } catch {
    return null;
  }
  return path.resolve(real, path.relative(probe, path.resolve(candidate)));
}

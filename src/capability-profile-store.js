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
import { nowIso, stableHash } from "./utils.js";

export const PROFILE_STATUSES = Object.freeze({
  ACTIVE: "active",
  REVOKED: "revoked"
});

export const CAPABILITY_BUNDLE_STATUSES = Object.freeze({
  DISABLED: "disabled",
  ENABLED: "enabled",
  REVOKED: "revoked"
});

export const FILESYSTEM_ACCESS = Object.freeze({
  NONE: "none",
  READ: "read",
  WRITE: "write"
});

export const CAPABILITY_ACCESS_FIELDS = Object.freeze([
  "filesystem",
  "network",
  "secrets",
  "subprocess",
  "api",
  "ui",
  "hooks"
]);

const PROFILE_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const PROJECT_ID_RE = PROFILE_ID_RE;
const GRANT_NAME_RE = /^[A-Za-z0-9*][A-Za-z0-9_.:/*-]{0,127}$/;
const SESSION_ID_RE = /^[\x21-\x7E]{1,512}$/;
const EVENT_OP_RE = /^[a-z][a-z-]{0,63}$/;
const SENSITIVE_KEY_RE = /(?:^|[_.:/-])(?:api.?key|authorization|bearer|cookie|credential|password|private.?key|access.?token|refresh.?token|secret|token)(?:$|[_.:/-])/i;
const PROFILE_CREATE_FIELDS = new Set([
  "id",
  "name",
  "persona",
  "modelProfile",
  "routingProfile",
  "activeSkills",
  "toolGrants",
  "capabilityBundleIds"
]);
const PROFILE_UPDATE_FIELDS = new Set([
  "expectedRevision",
  "name",
  "persona",
  "modelProfile",
  "routingProfile",
  "activeSkills",
  "toolGrants",
  "capabilityBundleIds"
]);
const BUNDLE_CREATE_FIELDS = new Set([
  "id",
  "name",
  "description",
  "toolGrants",
  "access"
]);
const BUNDLE_UPDATE_FIELDS = new Set([
  "expectedRevision",
  "name",
  "description",
  "toolGrants",
  "access"
]);
const ACCESS_FIELDS = new Set(CAPABILITY_ACCESS_FIELDS);
const STORED_PROFILE_FIELDS = new Set([
  "version",
  "id",
  "projectId",
  "name",
  "status",
  "revision",
  "persona",
  "modelProfile",
  "routingProfile",
  "activeSkills",
  "toolGrants",
  "capabilityBundleIds",
  "createdAt",
  "createdBy",
  "updatedAt",
  "updatedBy",
  "revokedAt",
  "revokedBy"
]);
const STORED_BUNDLE_FIELDS = new Set([
  "version",
  "id",
  "projectId",
  "name",
  "description",
  "status",
  "revision",
  "toolGrants",
  "access",
  "createdAt",
  "createdBy",
  "updatedAt",
  "updatedBy",
  "revokedAt",
  "revokedBy"
]);
const STORED_STATE_FIELDS = new Set([
  "version",
  "sequence",
  "updatedAt",
  "profiles",
  "bundles",
  "projectBindings",
  "sessionBindings"
]);
const MAX_PROFILES = 512;
const MAX_BUNDLES = 512;
const MAX_BINDINGS = 10_000;
const MAX_ITEMS = 256;
const MAX_PERSONA_CHARS = 24_000;
const MAX_PROFILE_DEPTH = 4;
const MAX_PROFILE_KEYS = 32;
const MAX_PROFILE_NODES = 1_024;
const MAX_PROFILE_CHARS = 64_000;
const MAX_EVENT_LINE_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_STATE_BYTES = 12 * 1024 * 1024;
const LOCK_RETRY_MS = 10;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 60_000;
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export class CapabilityProfileRevisionError extends Error {
  constructor(kind, id, expectedRevision, actualRevision) {
    super(
      `${kind} revision conflict for '${id}': expected ${expectedRevision}, found ${actualRevision ?? "none"}.`
    );
    this.name = "CapabilityProfileRevisionError";
    this.code = "CAPABILITY_PROFILE_REVISION_CONFLICT";
    this.kind = kind;
    this.id = id;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision ?? null;
  }
}

export class CapabilityProfileBoundaryError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CapabilityProfileBoundaryError";
    this.code = "CAPABILITY_PROFILE_BOUNDARY";
    Object.assign(this, details);
  }
}

// Durable, project-scoped named profiles and reusable capability grants.
//
// Profiles are optional. A project without a binding keeps the historical
// behavior. Once a profile is bound it can only narrow the project's skills
// and tools. A revoked-but-still-bound profile is intentionally deny-all so
// revocation cannot accidentally broaden access through fallback.
export class CapabilityProfileStore {
  constructor(options = {}) {
    const source = plainRecord(options, "CapabilityProfileStore options");
    const dataDir = path.resolve(source.dataDir ?? resolveDataDir());
    this.dir = path.resolve(source.dir ?? path.join(dataDir, "capability-profiles"));
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.snapshotPath = path.join(this.dir, "snapshot.json");
    this.lockPath = path.join(this.dir, ".mutation.lock");
    this.projects = source.projects ?? null;
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
      DEFAULT_LOCK_TIMEOUT_MS
    );
    this.staleLockMs = positiveInteger(
      source.staleLockMs,
      DEFAULT_STALE_LOCK_MS
    );
    this.lockDepth = 0;
    this.pendingChanges = null;
    this.sequence = 0;
    this.journalHealthy = true;
    this.journalError = null;
    this.profiles = new Map();
    this.bundles = new Map();
    this.projectBindings = new Map();
    this.sessionBindings = new Map();
    ensureDir(this.dir);
    this._withLock(() => this._restore());
  }

  listProfiles({ projectId, includeRevoked = false } = {}) {
    const project = this._authorizeProject(projectId);
    requireBoolean(includeRevoked, "includeRevoked");
    return this._readFresh(() => [...this.profiles.values()]
      .filter((profile) => profile.projectId === project.id)
      .filter((profile) => includeRevoked || profile.status === PROFILE_STATUSES.ACTIVE)
      .sort(compareNamedRecords)
      .map((profile) => this._profileView(profile)));
  }

  getProfile(projectId, profileId, { includeRevoked = true } = {}) {
    const project = this._authorizeProject(projectId);
    requireBoolean(includeRevoked, "includeRevoked");
    const key = scopedKey(project.id, normalizeId(profileId, "profile id"));
    return this._readFresh(() => {
      const profile = this.profiles.get(key) ?? null;
      if (
        !profile
        || (!includeRevoked && profile.status === PROFILE_STATUSES.REVOKED)
      ) {
        return null;
      }
      return this._profileView(profile);
    });
  }

  createProfile(projectId, input = {}, context = {}) {
    const project = this._authorizeProject(projectId);
    const source = plainRecord(input, "profile");
    assertOnlyKeys(source, PROFILE_CREATE_FIELDS, "profile");
    return this._mutate(() => {
      if (this.profiles.size >= MAX_PROFILES) {
        throw new RangeError(`Profile limit reached (${MAX_PROFILES}).`);
      }
      const id = normalizeId(source.id, "profile id");
      const key = scopedKey(project.id, id);
      if (this.profiles.has(key)) {
        throw new Error(`Profile '${id}' already exists in project '${project.id}'.`);
      }
      const at = this._now();
      const profile = normalizeStoredProfile({
        version: 1,
        id,
        projectId: project.id,
        name: requiredText(source.name, "profile name", 200),
        status: PROFILE_STATUSES.ACTIVE,
        revision: 1,
        persona: normalizePersona(source.persona),
        modelProfile: normalizeJsonProfile(source.modelProfile, "modelProfile"),
        routingProfile: normalizeJsonProfile(source.routingProfile, "routingProfile"),
        activeSkills: normalizeGrantList(source.activeSkills, "activeSkills"),
        toolGrants: normalizeGrantList(source.toolGrants, "toolGrants"),
        capabilityBundleIds: this._normalizeBundleRefs(
          project.id,
          source.capabilityBundleIds
        ),
        createdAt: at,
        createdBy: actor(context),
        updatedAt: at,
        updatedBy: actor(context),
        revokedAt: null,
        revokedBy: null
      });
      this.profiles.set(key, profile);
      this._commit("profile-create", project.id, "profile", id, {
        revision: profile.revision,
        actor: actor(context)
      });
      return this._profileView(profile);
    });
  }

  updateProfile(projectId, profileId, patch = {}, context = {}) {
    const project = this._authorizeProject(projectId);
    const id = normalizeId(profileId, "profile id");
    const source = plainRecord(patch, "profile patch");
    assertOnlyKeys(source, PROFILE_UPDATE_FIELDS, "profile patch");
    return this._mutate(() => {
      const key = scopedKey(project.id, id);
      const current = this._requireActiveProfile(key);
      assertRevision(
        "Profile",
        id,
        current.revision,
        source.expectedRevision ?? context.expectedRevision
      );
      const next = normalizeStoredProfile({
        ...current,
        name: source.name === undefined
          ? current.name
          : requiredText(source.name, "profile name", 200),
        persona: source.persona === undefined
          ? current.persona
          : normalizePersona(source.persona),
        modelProfile: source.modelProfile === undefined
          ? current.modelProfile
          : normalizeJsonProfile(source.modelProfile, "modelProfile"),
        routingProfile: source.routingProfile === undefined
          ? current.routingProfile
          : normalizeJsonProfile(source.routingProfile, "routingProfile"),
        activeSkills: source.activeSkills === undefined
          ? current.activeSkills
          : normalizeGrantList(source.activeSkills, "activeSkills"),
        toolGrants: source.toolGrants === undefined
          ? current.toolGrants
          : normalizeGrantList(source.toolGrants, "toolGrants"),
        capabilityBundleIds: source.capabilityBundleIds === undefined
          ? current.capabilityBundleIds
          : this._normalizeBundleRefs(project.id, source.capabilityBundleIds),
        revision: nextRevision(current.revision),
        updatedAt: this._now(),
        updatedBy: actor(context)
      });
      this.profiles.set(key, next);
      this._commit("profile-update", project.id, "profile", id, {
        revision: next.revision,
        actor: actor(context)
      });
      return this._profileView(next);
    });
  }

  revokeProfile(projectId, profileId, context = {}) {
    const project = this._authorizeProject(projectId);
    const id = normalizeId(profileId, "profile id");
    return this._mutate(() => {
      const key = scopedKey(project.id, id);
      const current = this.profiles.get(key);
      if (!current) throw new Error(`Unknown profile: ${id}`);
      assertRevision(
        "Profile",
        id,
        current.revision,
        context.expectedRevision
      );
      if (current.status === PROFILE_STATUSES.REVOKED) {
        return this._profileView(current);
      }
      const at = this._now();
      const next = normalizeStoredProfile({
        ...current,
        status: PROFILE_STATUSES.REVOKED,
        revision: nextRevision(current.revision),
        updatedAt: at,
        updatedBy: actor(context),
        revokedAt: at,
        revokedBy: actor(context)
      });
      this.profiles.set(key, next);
      this._commit("profile-revoke", project.id, "profile", id, {
        revision: next.revision,
        actor: actor(context)
      });
      return this._profileView(next);
    });
  }

  listBundles({ projectId, includeRevoked = false } = {}) {
    const project = this._authorizeProject(projectId);
    requireBoolean(includeRevoked, "includeRevoked");
    return this._readFresh(() => [...this.bundles.values()]
      .filter((bundle) => bundle.projectId === project.id)
      .filter((bundle) => (
        includeRevoked || bundle.status !== CAPABILITY_BUNDLE_STATUSES.REVOKED
      ))
      .sort(compareNamedRecords)
      .map((bundle) => structuredClone(bundle)));
  }

  getBundle(projectId, bundleId, { includeRevoked = true } = {}) {
    const project = this._authorizeProject(projectId);
    requireBoolean(includeRevoked, "includeRevoked");
    const key = scopedKey(project.id, normalizeId(bundleId, "bundle id"));
    return this._readFresh(() => {
      const bundle = this.bundles.get(key) ?? null;
      if (
        !bundle
        || (
          !includeRevoked
          && bundle.status === CAPABILITY_BUNDLE_STATUSES.REVOKED
        )
      ) {
        return null;
      }
      return structuredClone(bundle);
    });
  }

  createBundle(projectId, input = {}, context = {}) {
    const project = this._authorizeProject(projectId);
    const source = plainRecord(input, "capability bundle");
    assertOnlyKeys(source, BUNDLE_CREATE_FIELDS, "capability bundle");
    return this._mutate(() => {
      if (this.bundles.size >= MAX_BUNDLES) {
        throw new RangeError(`Capability bundle limit reached (${MAX_BUNDLES}).`);
      }
      const id = normalizeId(source.id, "bundle id");
      const key = scopedKey(project.id, id);
      if (this.bundles.has(key)) {
        throw new Error(`Capability bundle '${id}' already exists in project '${project.id}'.`);
      }
      const at = this._now();
      const bundle = normalizeStoredBundle({
        version: 1,
        id,
        projectId: project.id,
        name: requiredText(source.name, "bundle name", 200),
        description: optionalText(source.description, "bundle description", 2000),
        // Creation can never smuggle an enabled grant. Enabling is a distinct,
        // human-approved, auditable transition.
        status: CAPABILITY_BUNDLE_STATUSES.DISABLED,
        revision: 1,
        toolGrants: normalizeGrantList(source.toolGrants, "toolGrants"),
        access: normalizeAccess(source.access, { requireAll: true }),
        createdAt: at,
        createdBy: actor(context),
        updatedAt: at,
        updatedBy: actor(context),
        revokedAt: null,
        revokedBy: null
      });
      this.bundles.set(key, bundle);
      this._commit("bundle-create", project.id, "bundle", id, {
        revision: bundle.revision,
        status: bundle.status,
        actor: actor(context)
      });
      return structuredClone(bundle);
    });
  }

  updateBundle(projectId, bundleId, patch = {}, context = {}) {
    const project = this._authorizeProject(projectId);
    const id = normalizeId(bundleId, "bundle id");
    const source = plainRecord(patch, "capability bundle patch");
    assertOnlyKeys(source, BUNDLE_UPDATE_FIELDS, "capability bundle patch");
    return this._mutate(() => {
      const key = scopedKey(project.id, id);
      const current = this._requireMutableBundle(key);
      assertRevision(
        "Capability bundle",
        id,
        current.revision,
        source.expectedRevision ?? context.expectedRevision
      );
      const next = normalizeStoredBundle({
        ...current,
        name: source.name === undefined
          ? current.name
          : requiredText(source.name, "bundle name", 200),
        description: source.description === undefined
          ? current.description
          : optionalText(source.description, "bundle description", 2000),
        toolGrants: source.toolGrants === undefined
          ? current.toolGrants
          : normalizeGrantList(source.toolGrants, "toolGrants"),
        access: source.access === undefined
          ? current.access
          : normalizeAccess(source.access, { requireAll: true }),
        // Any permission edit returns the bundle to disabled review state.
        status: CAPABILITY_BUNDLE_STATUSES.DISABLED,
        revision: nextRevision(current.revision),
        updatedAt: this._now(),
        updatedBy: actor(context)
      });
      this.bundles.set(key, next);
      this._commit("bundle-update", project.id, "bundle", id, {
        revision: next.revision,
        status: next.status,
        actor: actor(context)
      });
      return structuredClone(next);
    });
  }

  setBundleEnabled(projectId, bundleId, enabled, context = {}) {
    const project = this._authorizeProject(projectId);
    const id = normalizeId(bundleId, "bundle id");
    requireBoolean(enabled, "enabled");
    return this._mutate(() => {
      const key = scopedKey(project.id, id);
      const current = this._requireMutableBundle(key);
      assertRevision(
        "Capability bundle",
        id,
        current.revision,
        context.expectedRevision
      );
      const status = enabled
        ? CAPABILITY_BUNDLE_STATUSES.ENABLED
        : CAPABILITY_BUNDLE_STATUSES.DISABLED;
      if (current.status === status) return structuredClone(current);
      const next = normalizeStoredBundle({
        ...current,
        status,
        revision: nextRevision(current.revision),
        updatedAt: this._now(),
        updatedBy: actor(context)
      });
      this.bundles.set(key, next);
      this._commit(
        enabled ? "bundle-enable" : "bundle-disable",
        project.id,
        "bundle",
        id,
        {
          revision: next.revision,
          status,
          actor: actor(context)
        }
      );
      return structuredClone(next);
    });
  }

  revokeBundle(projectId, bundleId, context = {}) {
    const project = this._authorizeProject(projectId);
    const id = normalizeId(bundleId, "bundle id");
    return this._mutate(() => {
      const key = scopedKey(project.id, id);
      const current = this.bundles.get(key);
      if (!current) throw new Error(`Unknown capability bundle: ${id}`);
      assertRevision(
        "Capability bundle",
        id,
        current.revision,
        context.expectedRevision
      );
      if (current.status === CAPABILITY_BUNDLE_STATUSES.REVOKED) {
        return structuredClone(current);
      }
      const at = this._now();
      const next = normalizeStoredBundle({
        ...current,
        status: CAPABILITY_BUNDLE_STATUSES.REVOKED,
        revision: nextRevision(current.revision),
        updatedAt: at,
        updatedBy: actor(context),
        revokedAt: at,
        revokedBy: actor(context)
      });
      this.bundles.set(key, next);
      this._commit("bundle-revoke", project.id, "bundle", id, {
        revision: next.revision,
        actor: actor(context)
      });
      return structuredClone(next);
    });
  }

  bindProjectProfile(projectId, profileId, context = {}) {
    const project = this._authorizeProject(projectId);
    const normalized = profileId == null || profileId === ""
      ? null
      : normalizeId(profileId, "profile id");
    return this._mutate(() => {
      assertBindingProfile(
        "project",
        project.id,
        this.projectBindings.get(project.id) ?? null,
        context
      );
      if (normalized) {
        const profile = this._requireActiveProfile(
          scopedKey(project.id, normalized)
        );
        assertOptionalRevision(
          "Profile",
          normalized,
          profile.revision,
          context.expectedProfileRevision
        );
      }
      if (normalized) this.projectBindings.set(project.id, normalized);
      else this.projectBindings.delete(project.id);
      this._commit(
        normalized ? "profile-bind-project" : "profile-unbind-project",
        project.id,
        "project-binding",
        project.id,
        {
          profileId: normalized,
          actor: actor(context)
        }
      );
      return this.resolve(project.id, null, { alreadyLocked: true });
    });
  }

  bindSessionProfile(projectId, sessionId, profileId, context = {}) {
    const normalizedSession = normalizeSessionId(sessionId);
    const project = this._authorizeProject(projectId, normalizedSession);
    const normalized = profileId == null || profileId === ""
      ? null
      : normalizeId(profileId, "profile id");
    return this._mutate(() => {
      const bindingKey = scopedKey(project.id, normalizedSession);
      assertBindingProfile(
        "session",
        normalizedSession,
        this.sessionBindings.get(bindingKey) ?? null,
        context
      );
      if (normalized) {
        const profile = this._requireActiveProfile(
          scopedKey(project.id, normalized)
        );
        assertOptionalRevision(
          "Profile",
          normalized,
          profile.revision,
          context.expectedProfileRevision
        );
      }
      if (
        normalized
        && !this.sessionBindings.has(bindingKey)
        && this.sessionBindings.size >= MAX_BINDINGS
      ) {
        throw new RangeError(`Profile session binding limit reached (${MAX_BINDINGS}).`);
      }
      if (normalized) this.sessionBindings.set(bindingKey, normalized);
      else this.sessionBindings.delete(bindingKey);
      this._commit(
        normalized ? "profile-bind-session" : "profile-unbind-session",
        project.id,
        "session-binding",
        normalizedSession,
        {
          profileId: normalized,
          actor: actor(context)
        }
      );
      return this.resolve(project.id, normalizedSession, { alreadyLocked: true });
    });
  }

  resolve(projectId, sessionId = null, options = {}) {
    const normalizedSession = sessionId == null || sessionId === ""
      ? null
      : normalizeSessionId(sessionId);
    const project = this._authorizeProject(projectId, normalizedSession);
    const operation = () => this._resolveLoaded(project.id, normalizedSession);
    return options.alreadyLocked === true
      ? operation()
      : this._readFresh(operation);
  }

  hasBinding(projectId, sessionId = null) {
    const id = normalizeProjectId(projectId);
    const normalizedSession = sessionId == null || sessionId === ""
      ? null
      : normalizeSessionId(sessionId);
    return this._readFresh(() => (
      (
        normalizedSession
        && this.sessionBindings.has(scopedKey(id, normalizedSession))
      )
      || this.projectBindings.has(id)
    ));
  }

  applyToProject(project, sessionId = null) {
    if (!project || typeof project !== "object") {
      throw new TypeError("project is required.");
    }
    const resolution = this.resolve(project.id, sessionId);
    if (!resolution.active) {
      return {
        project: structuredClone(project),
        resolution
      };
    }
    const baseAllowed = normalizeExistingGrantList(
      project.policy?.allowedTools,
      ["*"]
    );
    const baseSkills = normalizeExistingGrantList(project.activeSkills, ["*"]);
    const effectiveTools = intersectGrants(baseAllowed, resolution.toolGrants);
    const effectiveSkills = intersectGrants(baseSkills, resolution.activeSkills);
    return {
      project: {
        ...structuredClone(project),
        activeSkills: effectiveSkills,
        modelProfile: {
          ...structuredClone(project.modelProfile ?? {}),
          ...structuredClone(resolution.modelProfile)
        },
        routingProfile: {
          ...structuredClone(project.routingProfile ?? {}),
          ...structuredClone(resolution.routingProfile)
        },
        policy: {
          ...structuredClone(project.policy ?? {}),
          allowedTools: effectiveTools
        },
        capabilityProfile: {
          id: resolution.profileId,
          revision: resolution.profileRevision,
          binding: resolution.binding,
          locked: resolution.locked
        }
      },
      resolution
    };
  }

  history({ projectId, limit = 100 } = {}) {
    const project = this._authorizeProject(projectId);
    const boundedLimit = integerInRange(limit, "limit", 1, 500);
    return this._readFresh(() => {
      const events = readEventLines(this.eventsPath)
        .map(parseEventLine)
        .filter(Boolean)
        .filter((event) => event.projectId === project.id)
        .sort((left, right) => right.sequence - left.sequence)
        .slice(0, boundedLimit)
        .map(({ state: _state, ...event }) => structuredClone(event));
      return events;
    });
  }

  _resolveLoaded(projectId, sessionId) {
    const sessionProfileId = sessionId
      ? this.sessionBindings.get(scopedKey(projectId, sessionId)) ?? null
      : null;
    const projectProfileId = this.projectBindings.get(projectId) ?? null;
    const profileId = sessionProfileId ?? projectProfileId;
    const binding = sessionProfileId
      ? "session"
      : projectProfileId
        ? "project"
        : null;
    if (!profileId) return inactiveResolution(projectId, sessionId);
    const profile = this.profiles.get(scopedKey(projectId, profileId)) ?? null;
    if (!profile || profile.status !== PROFILE_STATUSES.ACTIVE) {
      return lockedResolution({
        projectId,
        sessionId,
        profileId,
        profileRevision: profile?.revision ?? null,
        profileStatus: profile?.status ?? "missing",
        binding,
        reason: profile
          ? "bound profile is revoked"
          : "bound profile is missing"
      });
    }

    const bundleStates = [];
    const enabledBundles = [];
    for (const bundleId of profile.capabilityBundleIds) {
      const bundle = this.bundles.get(scopedKey(projectId, bundleId)) ?? null;
      bundleStates.push({
        id: bundleId,
        revision: bundle?.revision ?? null,
        status: bundle?.status ?? "missing"
      });
      if (bundle?.status === CAPABILITY_BUNDLE_STATUSES.ENABLED) {
        enabledBundles.push(bundle);
      }
    }
    const toolGrants = unionGrants([
      profile.toolGrants,
      ...enabledBundles.map((bundle) => bundle.toolGrants)
    ]);
    const bundleAuthorizations = enabledBundles.map((bundle) => ({
      id: bundle.id,
      revision: bundle.revision,
      toolGrants: [...bundle.toolGrants],
      access: structuredClone(bundle.access)
    }));
    const access = mergeAccess(enabledBundles.map((bundle) => bundle.access));
    const identity = stableHash({
      version: 1,
      projectId,
      sessionId,
      profileId: profile.id,
      profileRevision: profile.revision,
      binding,
      bundleStates,
      toolGrants,
      activeSkills: profile.activeSkills,
      bundleAuthorizations,
      access
    });
    return {
      version: 1,
      active: true,
      locked: false,
      reason: null,
      projectId,
      sessionId,
      binding,
      profileId: profile.id,
      profileRevision: profile.revision,
      profileStatus: profile.status,
      profileName: profile.name,
      persona: profile.persona,
      modelProfile: structuredClone(profile.modelProfile),
      routingProfile: structuredClone(profile.routingProfile),
      activeSkills: [...profile.activeSkills],
      toolGrants,
      capabilityBundleIds: [...profile.capabilityBundleIds],
      bundleStates,
      bundleAuthorizations,
      access,
      identity
    };
  }

  _normalizeBundleRefs(projectId, value) {
    const ids = normalizeIdList(value, "capabilityBundleIds");
    for (const id of ids) {
      const bundle = this.bundles.get(scopedKey(projectId, id));
      if (!bundle || bundle.status === CAPABILITY_BUNDLE_STATUSES.REVOKED) {
        throw new CapabilityProfileBoundaryError(
          `Capability bundle '${id}' is unavailable in project '${projectId}'.`,
          { projectId, bundleId: id }
        );
      }
    }
    return ids;
  }

  _requireActiveProfile(key) {
    const profile = this.profiles.get(key);
    if (!profile) throw new Error(`Unknown profile: ${unscopedKey(key)}`);
    if (profile.status !== PROFILE_STATUSES.ACTIVE) {
      throw new Error(`Profile '${profile.id}' is revoked.`);
    }
    return profile;
  }

  _requireMutableBundle(key) {
    const bundle = this.bundles.get(key);
    if (!bundle) throw new Error(`Unknown capability bundle: ${unscopedKey(key)}`);
    if (bundle.status === CAPABILITY_BUNDLE_STATUSES.REVOKED) {
      throw new Error(`Capability bundle '${bundle.id}' is revoked.`);
    }
    return bundle;
  }

  _profileView(profile) {
    const projectDefault = this.projectBindings.get(profile.projectId) === profile.id;
    const sessionIds = [...this.sessionBindings.entries()]
      .filter(([key, profileId]) => (
        key.startsWith(`${profile.projectId}\u0000`)
        && profileId === profile.id
      ))
      .map(([key]) => key.slice(key.indexOf("\u0000") + 1))
      .sort();
    return structuredClone({
      ...profile,
      projectDefault,
      sessionIds
    });
  }

  _authorizeProject(projectId, sessionId = null) {
    const id = normalizeProjectId(projectId);
    if (!this.projects) return { id };
    let project;
    try {
      project = typeof this.projects.authorize === "function"
        ? this.projects.authorize(id, {
            includeArchived: false,
            ...(sessionId ? { sessionId } : {})
          })
        : this.projects.get?.(id, { includeArchived: false });
    } catch (error) {
      throw new CapabilityProfileBoundaryError(
        `Project '${id}' cannot authorize capability profiles.`,
        {
          projectId: id,
          sessionId,
          cause: error?.message ?? String(error)
        }
      );
    }
    if (!project) {
      throw new CapabilityProfileBoundaryError(
        `Unknown or archived project '${id}'.`,
        { projectId: id, sessionId }
      );
    }
    return project;
  }

  _readFresh(operation) {
    return this._withLock(() => {
      this._restore();
      this._assertJournalHealthy();
      return operation();
    });
  }

  _mutate(operation) {
    const outermost = this.lockDepth === 0;
    let result;
    let changes = [];
    let failure = null;
    try {
      result = this._withLock(() => {
        if (outermost) {
          this._restore();
          this._assertJournalHealthy();
          this.pendingChanges = [];
        }
        return operation();
      });
    } catch (error) {
      failure = error;
    } finally {
      if (outermost) {
        changes = this.pendingChanges ?? [];
        this.pendingChanges = null;
      }
    }
    if (outermost) {
      for (const change of changes) {
        try { this.onChange?.(structuredClone(change)); } catch { /* advisory */ }
      }
    }
    if (failure) throw failure;
    return result;
  }

  _withLock(operation) {
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
            try { fs.unlinkSync(this.lockPath); } catch { /* best effort */ }
          }
          throw error;
        }
        if (!this._breakStaleLock() && Date.now() >= deadline) {
          throw new Error("Capability profile store is busy.");
        }
        if (!acquired) waitSynchronously(LOCK_RETRY_MS);
      } finally {
        try { if (fd !== undefined) fs.closeSync(fd); } catch { /* best effort */ }
      }
    }
    this.lockDepth = 1;
    try {
      return operation();
    } finally {
      this.lockDepth = 0;
      this._releaseLock(token);
    }
  }

  _breakStaleLock() {
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
    let owner = null;
    try { owner = JSON.parse(content); } catch { /* invalid owner */ }
    if (processIsAlive(owner?.pid)) return false;
    try {
      if (fs.readFileSync(this.lockPath, "utf8") !== content) return false;
      fs.unlinkSync(this.lockPath);
      return true;
    } catch {
      return false;
    }
  }

  _releaseLock(token) {
    try {
      if (fs.readFileSync(this.lockPath, "utf8") === token) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      // Never remove an unverified lock.
    }
  }

  _commit(op, projectId, targetType, targetId, details = {}) {
    if (this.lockDepth < 1 || !Array.isArray(this.pendingChanges)) {
      throw new Error("Capability profile commits require the mutation lock.");
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
      targetType,
      targetId,
      ...details,
      state
    };
    if (
      jsonBytes(state) > MAX_STATE_BYTES
      || jsonBytes(event) > MAX_EVENT_LINE_BYTES
    ) {
      this._restore();
      throw new RangeError("Capability profile state exceeds its persistence bound.");
    }
    let appendError = null;
    try {
      this.appendEvent(this.eventsPath, event);
    } catch (error) {
      appendError = error;
      this._restore();
      if (
        this.sequence !== sequence
        || stableHash(this._state(state.updatedAt, this.sequence)) !== stableHash(state)
      ) {
        throw error;
      }
    }
    if (!appendError) this.sequence = sequence;
    try {
      this.writeSnapshot(this.snapshotPath, state);
    } catch (error) {
      console.warn(`[capability-profiles] snapshot refresh failed: ${error?.message ?? error}`);
    }
    this.pendingChanges.push({
      op,
      at,
      sequence,
      projectId,
      targetType,
      targetId,
      ...details
    });
  }

  _state(at = this._now(), sequence = this.sequence) {
    return {
      version: 1,
      sequence,
      updatedAt: at,
      profiles: [...this.profiles.values()]
        .map((profile) => structuredClone(profile))
        .sort(compareScopedRecords),
      bundles: [...this.bundles.values()]
        .map((bundle) => structuredClone(bundle))
        .sort(compareScopedRecords),
      projectBindings: [...this.projectBindings.entries()]
        .map(([projectId, profileId]) => ({ projectId, profileId }))
        .sort((left, right) => left.projectId.localeCompare(right.projectId)),
      sessionBindings: [...this.sessionBindings.entries()]
        .map(([key, profileId]) => {
          const separator = key.indexOf("\u0000");
          return {
            projectId: key.slice(0, separator),
            sessionId: key.slice(separator + 1),
            profileId
          };
        })
        .sort((left, right) => (
          left.projectId.localeCompare(right.projectId)
          || left.sessionId.localeCompare(right.sessionId)
        ))
    };
  }

  _restore() {
    this.sequence = 0;
    this.journalHealthy = true;
    this.journalError = null;
    this.profiles = new Map();
    this.bundles = new Map();
    this.projectBindings = new Map();
    this.sessionBindings = new Map();
    let snapshot = null;
    try {
      if (fs.statSync(this.snapshotPath).size <= MAX_SNAPSHOT_BYTES) {
        snapshot = readJsonFile(this.snapshotPath, null);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") snapshot = null;
    }
    if (validState(snapshot)) {
      try { this._applyState(snapshot); } catch { /* replay below */ }
    }
    let lines = [];
    try {
      lines = readEventLines(this.eventsPath);
    } catch (error) {
      this._markJournalUnhealthy(error?.message ?? "event log cannot be read");
      return;
    }
    let expectedSequence = 1;
    let replayBlocked = false;
    let highestValidSequence = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE_BYTES) {
        this._markJournalUnhealthy("event line exceeds its size bound");
        replayBlocked = true;
        continue;
      }
      const event = parseEventLine(line);
      if (
        !event
        || event.sequence !== expectedSequence
        || !validState(event.state)
        || event.state.sequence !== event.sequence
        || event.state.updatedAt !== event.at
      ) {
        this._markJournalUnhealthy(
          `event sequence ${expectedSequence} is missing or invalid`
        );
        replayBlocked = true;
        if (event?.sequence >= expectedSequence) {
          expectedSequence = event.sequence + 1;
        }
        continue;
      }
      expectedSequence += 1;
      highestValidSequence = event.sequence;
      if (replayBlocked || event.sequence <= this.sequence) continue;
      try {
        this._applyState(event.state);
      } catch {
        this._markJournalUnhealthy(
          `event sequence ${event.sequence} has invalid state`
        );
        replayBlocked = true;
      }
    }
    if (snapshot?.sequence > highestValidSequence) {
      this._markJournalUnhealthy(
        "snapshot authority is newer than the event journal"
      );
    }
  }

  _markJournalUnhealthy(reason) {
    this.journalHealthy = false;
    this.journalError ??= String(reason || "authority journal is invalid");
  }

  _assertJournalHealthy() {
    if (this.journalHealthy) return;
    throw new CapabilityProfileBoundaryError(
      `Capability profile authority journal is unavailable: ${this.journalError}.`,
      { journalHealthy: false }
    );
  }

  _applyState(state) {
    const profiles = new Map();
    for (const raw of state.profiles) {
      const profile = normalizeStoredProfile(raw);
      const key = scopedKey(profile.projectId, profile.id);
      if (profiles.has(key)) throw new TypeError("Duplicate stored profile.");
      profiles.set(key, profile);
    }
    const bundles = new Map();
    for (const raw of state.bundles) {
      const bundle = normalizeStoredBundle(raw);
      const key = scopedKey(bundle.projectId, bundle.id);
      if (bundles.has(key)) throw new TypeError("Duplicate stored bundle.");
      bundles.set(key, bundle);
    }
    const projectBindings = new Map();
    for (const raw of state.projectBindings) {
      const binding = plainRecord(raw, "project profile binding");
      assertOnlyKeys(
        binding,
        new Set(["projectId", "profileId"]),
        "project profile binding"
      );
      const projectId = normalizeProjectId(binding.projectId);
      const profileId = normalizeId(binding.profileId, "profile id");
      if (
        projectBindings.has(projectId)
        || !profiles.has(scopedKey(projectId, profileId))
      ) {
        throw new TypeError("Invalid project profile binding.");
      }
      projectBindings.set(projectId, profileId);
    }
    const sessionBindings = new Map();
    for (const raw of state.sessionBindings) {
      const binding = plainRecord(raw, "session profile binding");
      assertOnlyKeys(
        binding,
        new Set(["projectId", "profileId", "sessionId"]),
        "session profile binding"
      );
      const projectId = normalizeProjectId(binding.projectId);
      const sessionId = normalizeSessionId(binding.sessionId);
      const profileId = normalizeId(binding.profileId, "profile id");
      const key = scopedKey(projectId, sessionId);
      if (
        sessionBindings.has(key)
        || !profiles.has(scopedKey(projectId, profileId))
      ) {
        throw new TypeError("Invalid session profile binding.");
      }
      sessionBindings.set(key, profileId);
    }
    for (const profile of profiles.values()) {
      for (const bundleId of profile.capabilityBundleIds) {
        if (!bundles.has(scopedKey(profile.projectId, bundleId))) {
          throw new TypeError("Stored profile references a missing bundle.");
        }
      }
    }
    this.profiles = profiles;
    this.bundles = bundles;
    this.projectBindings = projectBindings;
    this.sessionBindings = sessionBindings;
    this.sequence = state.sequence;
  }

  _now() {
    const value = this.now();
    const parsed = value instanceof Date ? value : new Date(value);
    return Number.isNaN(parsed.getTime()) ? nowIso() : parsed.toISOString();
  }
}

export function profileCapabilityBoundaryError(tool, resolution) {
  if (!resolution?.active) return null;
  if (resolution.locked) {
    return `Capability profile '${resolution.profileId ?? "(missing)"}' is locked: ${resolution.reason ?? "unavailable"}.`;
  }
  const name = String(tool?.name ?? "").trim();
  if (!grantAllows(resolution.toolGrants, name)) {
    return `Tool '${name}' is not granted by capability profile '${resolution.profileId}'.`;
  }
  const required = requiredToolAccess(tool);
  if (!requiresCapabilityAccess(required)) return null;
  const authorizations = Array.isArray(resolution.bundleAuthorizations)
    ? resolution.bundleAuthorizations
    : null;
  if (authorizations) {
    const authorized = authorizations.some((authorization) => (
      grantAllows(authorization?.toolGrants, name)
      && capabilityAccessCovers(authorization?.access, required)
    ));
    if (authorized) return null;
    return `Tool '${name}' requires an enabled capability bundle that grants this exact tool and all required access for profile '${resolution.profileId}'.`;
  }
  // Backward compatibility for callers constructing an isolated resolution
  // in tests or integrations. Store-produced resolutions always carry
  // per-bundle authorizations and never merge unrelated bundle authority.
  const access = resolution.access ?? emptyAccess();
  if (capabilityAccessCovers(access, required)) return null;
  if (required.filesystem === FILESYSTEM_ACCESS.WRITE) {
    if (access.filesystem !== FILESYSTEM_ACCESS.WRITE) {
      return `Tool '${name}' requires filesystem write access not granted by profile '${resolution.profileId}'.`;
    }
  } else if (
    required.filesystem === FILESYSTEM_ACCESS.READ
    && access.filesystem === FILESYSTEM_ACCESS.NONE
  ) {
    return `Tool '${name}' requires filesystem read access not granted by profile '${resolution.profileId}'.`;
  }
  for (const field of CAPABILITY_ACCESS_FIELDS.slice(1)) {
    if (required[field] && access[field] !== true) {
      return `Tool '${name}' requires ${field} access not granted by profile '${resolution.profileId}'.`;
    }
  }
  return null;
}

function requiresCapabilityAccess(required) {
  return required.filesystem !== FILESYSTEM_ACCESS.NONE
    || CAPABILITY_ACCESS_FIELDS.slice(1).some((field) => required[field] === true);
}

function capabilityAccessCovers(value, required) {
  let access;
  try {
    access = normalizeAccess(value ?? emptyAccess(), { requireAll: true });
  } catch {
    return false;
  }
  if (
    required.filesystem === FILESYSTEM_ACCESS.WRITE
    && access.filesystem !== FILESYSTEM_ACCESS.WRITE
  ) {
    return false;
  }
  if (
    required.filesystem === FILESYSTEM_ACCESS.READ
    && access.filesystem === FILESYSTEM_ACCESS.NONE
  ) {
    return false;
  }
  return CAPABILITY_ACCESS_FIELDS.slice(1)
    .every((field) => !required[field] || access[field] === true);
}

export function requiredToolAccess(tool) {
  const required = emptyAccess();
  const resources = Array.isArray(tool?.capability?.resources)
    ? tool.capability.resources
    : [];
  for (const raw of resources) {
    const resource = String(raw ?? "").trim().toLowerCase();
    if (resource === "filesystem" || resource === "file" || resource === "fs") {
      required.filesystem = tool?.sideEffects
        ? FILESYSTEM_ACCESS.WRITE
        : FILESYSTEM_ACCESS.READ;
    } else if (resource === "network") required.network = true;
    else if (resource === "secret" || resource === "secrets") required.secrets = true;
    else if (resource === "subprocess" || resource === "process") required.subprocess = true;
    else if (resource === "api") required.api = true;
    else if (resource === "ui") required.ui = true;
    else if (resource === "hook" || resource === "hooks") required.hooks = true;
  }
  const source = String(tool?.source ?? "").toLowerCase();
  const name = String(tool?.name ?? "").toLowerCase();
  if (source === "mcp") {
    required.api = true;
    required.network = true;
    if ((tool?.metadata?.requiredSecretRefs?.length ?? 0) > 0) {
      required.secrets = true;
    }
  }
  if (/^code_(?:read|search)$/u.test(name)) {
    required.filesystem = FILESYSTEM_ACCESS.READ;
  }
  if (/^code_(?:edit|write)$/u.test(name)) {
    required.filesystem = FILESYSTEM_ACCESS.WRITE;
  }
  if (/^code_(?:lint|test)$/u.test(name)) {
    required.filesystem = FILESYSTEM_ACCESS.READ;
    required.subprocess = true;
  }
  if (name === "code_shell") {
    required.filesystem = FILESYSTEM_ACCESS.WRITE;
    required.subprocess = true;
    required.secrets = true;
  }
  if (name === "execute_code") required.subprocess = true;
  if (name === "web_search" || name === "fetch_url") {
    required.network = true;
    required.api = true;
  }
  if (name.startsWith("browser_")) {
    required.ui = true;
    if (!name.endsWith("_screenshot")) required.network = true;
  }
  if (name.startsWith("computer_")) required.ui = true;
  if (name.startsWith("hook_")) required.hooks = true;
  if (name.includes("secret")) required.secrets = true;
  return required;
}

export function emptyCapabilityAccess() {
  return emptyAccess();
}

function inactiveResolution(projectId, sessionId) {
  return {
    version: 1,
    active: false,
    locked: false,
    reason: null,
    projectId,
    sessionId,
    binding: null,
    profileId: null,
    profileRevision: null,
    profileStatus: null,
    profileName: null,
    persona: "",
    modelProfile: {},
    routingProfile: {},
    activeSkills: null,
    toolGrants: null,
    capabilityBundleIds: [],
    bundleStates: [],
    bundleAuthorizations: [],
    access: null,
    identity: null
  };
}

function lockedResolution({
  projectId,
  sessionId,
  profileId,
  profileRevision,
  profileStatus,
  binding,
  reason
}) {
  return {
    version: 1,
    active: true,
    locked: true,
    reason,
    projectId,
    sessionId,
    binding,
    profileId,
    profileRevision,
    profileStatus,
    profileName: null,
    persona: "",
    modelProfile: {},
    routingProfile: {},
    activeSkills: [],
    toolGrants: [],
    capabilityBundleIds: [],
    bundleStates: [],
    bundleAuthorizations: [],
    access: emptyAccess(),
    identity: stableHash({
      version: 1,
      projectId,
      sessionId,
      profileId,
      profileRevision,
      profileStatus,
      binding,
      locked: true
    })
  };
}

function normalizeStoredProfile(value) {
  const source = plainRecord(value, "stored profile");
  assertOnlyKeys(source, STORED_PROFILE_FIELDS, "stored profile");
  if (source.version !== 1) throw new TypeError("Invalid stored profile version.");
  const status = source.status;
  if (!Object.values(PROFILE_STATUSES).includes(status)) {
    throw new TypeError("Invalid stored profile status.");
  }
  const revokedAt = source.revokedAt == null
    ? null
    : requiredIso(source.revokedAt, "revokedAt");
  if (
    (status === PROFILE_STATUSES.REVOKED) !== (revokedAt !== null)
  ) {
    throw new TypeError("Profile status and revokedAt are inconsistent.");
  }
  return {
    version: 1,
    id: normalizeId(source.id, "profile id"),
    projectId: normalizeProjectId(source.projectId),
    name: requiredText(source.name, "profile name", 200),
    status,
    revision: positiveInteger(source.revision, null, "profile revision"),
    persona: normalizePersona(source.persona),
    modelProfile: normalizeJsonProfile(source.modelProfile, "modelProfile"),
    routingProfile: normalizeJsonProfile(source.routingProfile, "routingProfile"),
    activeSkills: normalizeGrantList(source.activeSkills, "activeSkills"),
    toolGrants: normalizeGrantList(source.toolGrants, "toolGrants"),
    capabilityBundleIds: normalizeIdList(
      source.capabilityBundleIds,
      "capabilityBundleIds"
    ),
    createdAt: requiredIso(source.createdAt, "createdAt"),
    createdBy: requiredText(source.createdBy, "createdBy", 200),
    updatedAt: requiredIso(source.updatedAt, "updatedAt"),
    updatedBy: requiredText(source.updatedBy, "updatedBy", 200),
    revokedAt,
    revokedBy: revokedAt
      ? requiredText(source.revokedBy, "revokedBy", 200)
      : null
  };
}

function normalizeStoredBundle(value) {
  const source = plainRecord(value, "stored capability bundle");
  assertOnlyKeys(source, STORED_BUNDLE_FIELDS, "stored capability bundle");
  if (source.version !== 1) throw new TypeError("Invalid stored capability bundle version.");
  const status = source.status;
  if (!Object.values(CAPABILITY_BUNDLE_STATUSES).includes(status)) {
    throw new TypeError("Invalid stored capability bundle status.");
  }
  const revokedAt = source.revokedAt == null
    ? null
    : requiredIso(source.revokedAt, "revokedAt");
  if (
    (status === CAPABILITY_BUNDLE_STATUSES.REVOKED) !== (revokedAt !== null)
  ) {
    throw new TypeError("Capability bundle status and revokedAt are inconsistent.");
  }
  return {
    version: 1,
    id: normalizeId(source.id, "bundle id"),
    projectId: normalizeProjectId(source.projectId),
    name: requiredText(source.name, "bundle name", 200),
    description: optionalText(source.description, "bundle description", 2000),
    status,
    revision: positiveInteger(source.revision, null, "bundle revision"),
    toolGrants: normalizeGrantList(source.toolGrants, "toolGrants"),
    access: normalizeAccess(source.access, { requireAll: true }),
    createdAt: requiredIso(source.createdAt, "createdAt"),
    createdBy: requiredText(source.createdBy, "createdBy", 200),
    updatedAt: requiredIso(source.updatedAt, "updatedAt"),
    updatedBy: requiredText(source.updatedBy, "updatedBy", 200),
    revokedAt,
    revokedBy: revokedAt
      ? requiredText(source.revokedBy, "revokedBy", 200)
      : null
  };
}

function validState(value) {
  try {
    const source = plainRecord(value, "stored capability profile state");
    assertOnlyKeys(source, STORED_STATE_FIELDS, "stored capability profile state");
    if (
      source.version !== 1
      || !Number.isSafeInteger(source.sequence)
      || source.sequence < 0
      || requiredIso(source.updatedAt, "updatedAt") !== source.updatedAt
    ) {
      return false;
    }
    const profiles = plainArray(source.profiles, "stored profiles", MAX_PROFILES);
    const bundles = plainArray(source.bundles, "stored bundles", MAX_BUNDLES);
    const projectBindings = plainArray(
      source.projectBindings,
      "stored project bindings",
      MAX_PROFILES
    );
    const sessionBindings = plainArray(
      source.sessionBindings,
      "stored session bindings",
      MAX_BINDINGS
    );
    const profileKeys = new Set();
    for (const raw of profiles) {
      const profile = normalizeStoredProfile(raw);
      const key = scopedKey(profile.projectId, profile.id);
      if (profileKeys.has(key)) return false;
      profileKeys.add(key);
    }
    const bundleKeys = new Set();
    for (const raw of bundles) {
      const bundle = normalizeStoredBundle(raw);
      const key = scopedKey(bundle.projectId, bundle.id);
      if (bundleKeys.has(key)) return false;
      bundleKeys.add(key);
    }
    if (projectBindings.length > MAX_PROFILES || sessionBindings.length > MAX_BINDINGS) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function normalizeAccess(value, { requireAll = false } = {}) {
  const source = plainRecord(value, "capability access");
  assertOnlyKeys(source, ACCESS_FIELDS, "capability access");
  if (requireAll) {
    for (const field of CAPABILITY_ACCESS_FIELDS) {
      if (!Object.hasOwn(source, field)) {
        throw new TypeError(`capability access must explicitly declare '${field}'.`);
      }
    }
  }
  const filesystem = source.filesystem ?? FILESYSTEM_ACCESS.NONE;
  if (!Object.values(FILESYSTEM_ACCESS).includes(filesystem)) {
    throw new TypeError("access.filesystem must be none, read, or write.");
  }
  const access = { filesystem };
  for (const field of CAPABILITY_ACCESS_FIELDS.slice(1)) {
    const item = source[field] ?? false;
    requireBoolean(item, `access.${field}`);
    access[field] = item;
  }
  return access;
}

function emptyAccess() {
  return {
    filesystem: FILESYSTEM_ACCESS.NONE,
    network: false,
    secrets: false,
    subprocess: false,
    api: false,
    ui: false,
    hooks: false
  };
}

function mergeAccess(values) {
  const merged = emptyAccess();
  for (const value of values) {
    const access = normalizeAccess(value, { requireAll: true });
    if (
      access.filesystem === FILESYSTEM_ACCESS.WRITE
      || (
        access.filesystem === FILESYSTEM_ACCESS.READ
        && merged.filesystem === FILESYSTEM_ACCESS.NONE
      )
    ) {
      merged.filesystem = access.filesystem;
    }
    for (const field of CAPABILITY_ACCESS_FIELDS.slice(1)) {
      merged[field] = merged[field] || access[field];
    }
  }
  return merged;
}

function normalizePersona(value) {
  if (value == null) return "";
  if (typeof value !== "string") throw new TypeError("persona must be a string.");
  if (value.length > MAX_PERSONA_CHARS) {
    throw new RangeError(`persona exceeds ${MAX_PERSONA_CHARS} characters.`);
  }
  if (/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new TypeError("persona contains unsupported control characters.");
  }
  return value.trim();
}

function normalizeJsonProfile(value, field) {
  if (value == null) return {};
  return normalizeJsonValue(value, field, 0, { chars: 0, nodes: 0 });
}

function normalizeJsonValue(value, field, depth, budget) {
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
    const values = plainArray(value, field, MAX_ITEMS);
    return values.map((item, index) => (
      normalizeJsonValue(item, `${field}[${index}]`, depth + 1, budget)
    ));
  }
  const source = plainRecord(value, field);
  const descriptors = Object.getOwnPropertyDescriptors(source);
  const entries = Object.entries(descriptors);
  if (entries.length > MAX_PROFILE_KEYS) {
    throw new RangeError(`${field} has too many keys.`);
  }
  const result = {};
  for (const [key, descriptor] of entries) {
    if (!GRANT_NAME_RE.test(key) || key === "*") {
      throw new TypeError(`${field} contains an invalid key.`);
    }
    if (SENSITIVE_KEY_RE.test(key)) {
      throw new TypeError(`${field} cannot contain credential-bearing fields.`);
    }
    if (!Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${field} cannot contain accessors.`);
    }
    budget.chars += key.length;
    if (budget.chars > MAX_PROFILE_CHARS) {
      throw new RangeError(`${field} contains too much text.`);
    }
    result[key] = normalizeJsonValue(
      descriptor.value,
      `${field}.${key}`,
      depth + 1,
      budget
    );
  }
  return result;
}

function normalizeGrantList(value, field) {
  if (value == null) return [];
  const values = plainArray(value, field, MAX_ITEMS).map((item) => {
    const text = requiredText(item, field, 128);
    if (!GRANT_NAME_RE.test(text)) {
      throw new TypeError(`Invalid ${field} value: ${text}`);
    }
    return text;
  });
  return [...new Set(values)].sort();
}

function normalizeExistingGrantList(value, fallback) {
  if (value == null) return [...fallback];
  try {
    return normalizeGrantList(value, "grants");
  } catch {
    return [];
  }
}

function assertBindingProfile(kind, id, actualProfileId, context) {
  if (!Object.hasOwn(context, "expectedBindingProfileId")) return;
  const raw = context.expectedBindingProfileId;
  const expected = raw == null || raw === ""
    ? null
    : normalizeId(raw, "expected binding profile id");
  if (expected === actualProfileId) return;
  throw new CapabilityProfileRevisionError(
    `${kind} profile binding`,
    id,
    expected ?? "unbound",
    actualProfileId ?? "unbound"
  );
}

function assertOptionalRevision(kind, id, actualRevision, expectedRevision) {
  if (expectedRevision === undefined) return;
  assertRevision(kind, id, actualRevision, expectedRevision);
}

function normalizeIdList(value, field) {
  if (value == null) return [];
  return [...new Set(
    plainArray(value, field, MAX_ITEMS)
      .map((item) => normalizeId(item, field))
  )].sort();
}

function unionGrants(lists) {
  const values = new Set();
  for (const list of lists) {
    for (const item of Array.isArray(list) ? list : []) values.add(item);
  }
  return values.has("*") ? ["*"] : [...values].sort();
}

function intersectGrants(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return [];
  const leftWildcard = left.includes("*");
  const rightWildcard = right.includes("*");
  if (leftWildcard && rightWildcard) return ["*"];
  if (leftWildcard) return [...new Set(right)].sort();
  if (rightWildcard) return [...new Set(left)].sort();
  const rightSet = new Set(right);
  return [...new Set(left.filter((item) => rightSet.has(item)))].sort();
}

function grantAllows(grants, value) {
  if (!Array.isArray(grants)) return false;
  return grants.includes("*") || grants.includes(value);
}

function parseEventLine(line) {
  try {
    const event = JSON.parse(line);
    if (
      event?.version !== 1
      || !Number.isSafeInteger(event.sequence)
      || event.sequence < 1
      || typeof event.op !== "string"
      || !EVENT_OP_RE.test(event.op)
      || typeof event.projectId !== "string"
      || typeof event.targetType !== "string"
      || typeof event.targetId !== "string"
      || requiredIso(event.at, "event timestamp") !== event.at
    ) {
      return null;
    }
    return event;
  } catch {
    return null;
  }
}

function readEventLines(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.size > 32 * 1024 * 1024) {
      throw new RangeError("Capability profile event log is too large.");
    }
    return fs.readFileSync(file, "utf8").split(/\r?\n/u);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function scopedKey(projectId, id) {
  return `${projectId}\u0000${id}`;
}

function unscopedKey(key) {
  const separator = key.indexOf("\u0000");
  return separator < 0 ? key : key.slice(separator + 1);
}

function normalizeProjectId(value) {
  if (typeof value !== "string") throw new TypeError("projectId must be a string.");
  const id = value.trim().toLowerCase();
  if (!PROJECT_ID_RE.test(id)) throw new TypeError("Invalid projectId.");
  return id;
}

function normalizeId(value, field) {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string.`);
  const id = value.trim().toLowerCase();
  if (!PROFILE_ID_RE.test(id)) throw new TypeError(`Invalid ${field}.`);
  return id;
}

function normalizeSessionId(value) {
  if (typeof value !== "string") throw new TypeError("sessionId must be a string.");
  const id = value.trim();
  if (!SESSION_ID_RE.test(id)) throw new TypeError("Invalid sessionId.");
  return id;
}

function plainRecord(value, field) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || utilTypes.isProxy(value)
  ) {
    throw new TypeError(`${field} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must be a plain object.`);
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${field}.${key} cannot be an accessor.`);
    }
  }
  return value;
}

function plainArray(value, field, max = MAX_ITEMS) {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new TypeError(`${field} must be an array.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (value.length > max) throw new RangeError(`${field} is too large.`);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${field} must be dense and contain no accessors.`);
    }
  }
  return value;
}

function assertOnlyKeys(source, allowed, field) {
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) throw new TypeError(`${field}.${key} is not supported.`);
  }
}

function requiredText(value, field, maxLength) {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string.`);
  const text = value.trim();
  if (!text) throw new TypeError(`${field} is required.`);
  if (text.length > maxLength) throw new RangeError(`${field} is too long.`);
  if (/[\u0000-\u001f\u007f]/u.test(text)) {
    throw new TypeError(`${field} contains unsupported control characters.`);
  }
  return text;
}

function optionalText(value, field, maxLength) {
  if (value == null || value === "") return "";
  return requiredText(value, field, maxLength);
}

function requiredIso(value, field) {
  const text = requiredText(value, field, 64);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${field} must be an ISO timestamp.`);
  return date.toISOString();
}

function requireBoolean(value, field) {
  if (typeof value !== "boolean") throw new TypeError(`${field} must be a boolean.`);
}

function positiveInteger(value, fallback, field = "value") {
  if (value == null && fallback != null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer.`);
  }
  return value;
}

function integerInRange(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${field} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function nextRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Revision limit reached.");
  }
  return value + 1;
}

function assertRevision(kind, id, actual, expected) {
  if (expected == null) return;
  if (!Number.isSafeInteger(expected) || expected < 1) {
    throw new TypeError("expectedRevision must be a positive integer.");
  }
  if (actual !== expected) {
    throw new CapabilityProfileRevisionError(kind, id, expected, actual);
  }
}

function actor(context) {
  const source = context == null ? {} : plainRecord(context, "actor context");
  return requiredText(
    String(
      source.actor
      ?? source.decidedBy
      ?? source.from
      ?? source.agentId
      ?? "runtime"
    ),
    "actor",
    200
  );
}

function compareNamedRecords(left, right) {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

function compareScopedRecords(left, right) {
  return left.projectId.localeCompare(right.projectId)
    || left.id.localeCompare(right.id);
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function waitSynchronously(milliseconds) {
  Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, milliseconds);
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

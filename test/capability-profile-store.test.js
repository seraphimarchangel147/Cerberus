import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CapabilityProfileBoundaryError,
  CapabilityProfileRevisionError,
  CapabilityProfileStore,
  profileCapabilityBoundaryError,
  requiredToolAccess
} from "../src/capability-profile-store.js";
import { ProjectStore } from "../src/project-store.js";

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-capability-profile-"));
  const dataDir = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const projects = new ProjectStore({
    dataDir,
    defaultWorkspaceRoot: workspace
  });
  projects.create({
    id: "alpha",
    name: "Alpha",
    activeSkills: ["triage", "release"],
    policy: {
      toolPolicy: "full",
      allowedTools: ["recall", "code_read", "code_write", "web_search"]
    }
  });
  projects.resolveForSession("alpha-session", {
    requestedProjectId: "alpha"
  });
  const store = new CapabilityProfileStore({ dataDir, projects });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { dataDir, projects, root, store };
}

function access(overrides = {}) {
  return {
    filesystem: "none",
    network: false,
    secrets: false,
    subprocess: false,
    api: false,
    ui: false,
    hooks: false,
    ...overrides
  };
}

test("profiles and disabled-by-default bundles persist, narrow, and revoke immediately", (t) => {
  const h = harness(t);
  const bundle = h.store.createBundle("alpha", {
    id: "workspace-read",
    name: "Workspace read",
    toolGrants: ["code_read"],
    access: access({ filesystem: "read" })
  }, { actor: "operator:create" });
  assert.equal(bundle.status, "disabled");
  assert.deepEqual(Object.keys(bundle.access).sort(), [
    "api",
    "filesystem",
    "hooks",
    "network",
    "secrets",
    "subprocess",
    "ui"
  ]);

  const profile = h.store.createProfile("alpha", {
    id: "reviewer",
    name: "Reviewer",
    persona: "Be exact and prefer read-only inspection.",
    modelProfile: { model: "review-model" },
    routingProfile: { tier: "mini", task: "review" },
    activeSkills: ["triage"],
    toolGrants: ["recall"],
    capabilityBundleIds: ["workspace-read"]
  }, { actor: "operator:create" });
  assert.equal(profile.revision, 1);

  h.store.bindProjectProfile("alpha", "reviewer", {
    actor: "operator:bind"
  });
  let resolved = h.store.resolve("alpha", "alpha-session");
  assert.equal(resolved.active, true);
  assert.equal(resolved.binding, "project");
  assert.deepEqual(resolved.toolGrants, ["recall"]);
  assert.equal(resolved.access.filesystem, "none");

  const enabled = h.store.setBundleEnabled(
    "alpha",
    "workspace-read",
    true,
    { expectedRevision: 1, actor: "operator:enable" }
  );
  assert.equal(enabled.status, "enabled");
  resolved = h.store.resolve("alpha", "alpha-session");
  assert.deepEqual(resolved.toolGrants, ["code_read", "recall"]);
  assert.equal(resolved.access.filesystem, "read");

  const applied = h.store.applyToProject(
    h.projects.get("alpha"),
    "alpha-session"
  );
  assert.deepEqual(applied.project.activeSkills, ["triage"]);
  assert.deepEqual(applied.project.policy.allowedTools, [
    "code_read",
    "recall"
  ]);
  assert.equal(applied.project.modelProfile.model, "review-model");
  assert.equal(applied.project.routingProfile.tier, "mini");

  const reloaded = new CapabilityProfileStore({
    dataDir: h.dataDir,
    projects: h.projects
  });
  assert.equal(
    reloaded.resolve("alpha", "alpha-session").identity,
    resolved.identity
  );

  const revokedBundle = reloaded.revokeBundle("alpha", "workspace-read", {
    expectedRevision: 2,
    actor: "operator:revoke"
  });
  assert.equal(revokedBundle.status, "revoked");
  resolved = h.store.resolve("alpha", "alpha-session");
  assert.deepEqual(resolved.toolGrants, ["recall"]);
  assert.equal(resolved.access.filesystem, "none");

  const revokedProfile = h.store.revokeProfile("alpha", "reviewer", {
    expectedRevision: 1,
    actor: "operator:revoke"
  });
  assert.equal(revokedProfile.status, "revoked");
  resolved = h.store.resolve("alpha", "alpha-session");
  assert.equal(resolved.locked, true);
  assert.deepEqual(resolved.toolGrants, []);

  const events = h.store.history({ projectId: "alpha" });
  assert.ok(events.some((event) => event.op === "bundle-enable"));
  assert.ok(events.some((event) => event.op === "bundle-revoke"));
  assert.ok(events.every((event) => !Object.hasOwn(event, "state")));
});

test("session profiles override project profiles without crossing project ownership", (t) => {
  const h = harness(t);
  h.store.createProfile("alpha", {
    id: "project-default",
    name: "Project default",
    activeSkills: ["triage"],
    toolGrants: ["recall"],
    capabilityBundleIds: []
  }, { actor: "operator" });
  h.store.createProfile("alpha", {
    id: "session-review",
    name: "Session review",
    activeSkills: ["release"],
    toolGrants: ["web_search"],
    capabilityBundleIds: []
  }, { actor: "operator" });
  h.store.bindProjectProfile("alpha", "project-default", { actor: "operator" });
  h.store.bindSessionProfile(
    "alpha",
    "alpha-session",
    "session-review",
    { actor: "operator" }
  );
  const session = h.store.resolve("alpha", "alpha-session");
  assert.equal(session.profileId, "session-review");
  assert.equal(session.binding, "session");
  assert.deepEqual(session.activeSkills, ["release"]);
  assert.deepEqual(session.toolGrants, ["web_search"]);

  assert.throws(
    () => h.store.resolve("default", "alpha-session"),
    CapabilityProfileBoundaryError
  );
  assert.throws(
    () => h.store.bindSessionProfile(
      "default",
      "alpha-session",
      null,
      { actor: "operator" }
    ),
    CapabilityProfileBoundaryError
  );
});

test("revision CAS, fixed access declarations, and plain-data validation fail closed", (t) => {
  const h = harness(t);
  assert.throws(
    () => h.store.createBundle("alpha", {
      id: "incomplete",
      name: "Incomplete",
      toolGrants: [],
      access: { filesystem: "none" }
    }),
    /explicitly declare 'network'/
  );
  const bundle = h.store.createBundle("alpha", {
    id: "safe",
    name: "Safe",
    toolGrants: [],
    access: access()
  });
  assert.throws(
    () => h.store.updateBundle("alpha", "safe", {
      expectedRevision: 2,
      description: "stale"
    }),
    CapabilityProfileRevisionError
  );
  const accessor = {};
  Object.defineProperty(accessor, "model", {
    enumerable: true,
    get() {
      throw new Error("accessor executed");
    }
  });
  assert.throws(
    () => h.store.createProfile("alpha", {
      id: "hostile",
      name: "Hostile",
      modelProfile: accessor,
      activeSkills: [],
      toolGrants: [],
      capabilityBundleIds: ["safe"]
    }),
    /accessor/
  );
  assert.throws(
    () => h.store.createProfile("alpha", {
      id: "function-patch",
      name: "Function patch",
      modelProfile: { patch: () => true },
      activeSkills: [],
      toolGrants: [],
      capabilityBundleIds: ["safe"]
    }),
    /plain object/
  );
  assert.throws(
    () => h.store.createProfile("alpha", {
      id: "credential-profile",
      name: "Credential profile",
      modelProfile: { apiKey: "must-not-persist" },
      activeSkills: [],
      toolGrants: [],
      capabilityBundleIds: ["safe"]
    }),
    /credential-bearing/
  );
  assert.equal(bundle.status, "disabled");
});

test("tool access classification requires exact grants and declared sensitive access", () => {
  const readTool = {
    name: "code_read",
    source: "internal",
    sideEffects: false,
    capability: { resources: [] }
  };
  const writeTool = {
    name: "code_write",
    source: "internal",
    sideEffects: true,
    capability: { resources: [] }
  };
  const webTool = {
    name: "web_search",
    source: "internal",
    sideEffects: false,
    capability: { resources: [] }
  };
  assert.equal(requiredToolAccess(readTool).filesystem, "read");
  assert.equal(requiredToolAccess(writeTool).filesystem, "write");
  assert.equal(requiredToolAccess(webTool).network, true);
  const resolution = {
    active: true,
    locked: false,
    profileId: "reviewer",
    toolGrants: ["code_read", "code_write", "web_search"],
    access: access({ filesystem: "read", network: true, api: true })
  };
  assert.equal(profileCapabilityBoundaryError(readTool, resolution), null);
  assert.match(
    profileCapabilityBoundaryError(writeTool, resolution),
    /filesystem write/
  );
  assert.equal(profileCapabilityBoundaryError(webTool, resolution), null);
  assert.match(
    profileCapabilityBoundaryError(
      { ...webTool, name: "not-granted" },
      resolution
    ),
    /not granted/
  );
});

test("project and profile grant intersections preserve explicit deny-all", (t) => {
  const h = harness(t);
  const cases = [
    { base: ["*"], profile: ["*"], expected: ["*"] },
    { base: ["*"], profile: ["recall"], expected: ["recall"] },
    { base: ["*"], profile: [], expected: [] },
    { base: ["recall"], profile: ["*"], expected: ["recall"] },
    { base: ["recall"], profile: ["recall"], expected: ["recall"] },
    { base: ["recall"], profile: [], expected: [] },
    { base: [], profile: ["*"], expected: [] },
    { base: [], profile: ["recall"], expected: [] },
    { base: [], profile: [], expected: [] }
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];
    const id = `matrix-${index}`;
    h.store.createProfile("alpha", {
      id,
      name: `Matrix ${index}`,
      activeSkills: [],
      toolGrants: item.profile,
      capabilityBundleIds: []
    }, { actor: "matrix" });
    h.store.bindSessionProfile("alpha", "alpha-session", id, {
      expectedBindingProfileId: index === 0 ? null : `matrix-${index - 1}`,
      expectedProfileRevision: 1,
      actor: "matrix"
    });
    const base = h.projects.get("alpha");
    base.policy.allowedTools = item.base;
    assert.deepEqual(
      h.store.applyToProject(base, "alpha-session").project.policy.allowedTools,
      item.expected,
      `base=${JSON.stringify(item.base)} profile=${JSON.stringify(item.profile)}`
    );
  }
});

test("sensitive tools cannot borrow access from an unrelated bundle", (t) => {
  const h = harness(t);
  h.store.createBundle("alpha", {
    id: "tool-only",
    name: "Tool only",
    toolGrants: ["code_read"],
    access: access()
  });
  h.store.createBundle("alpha", {
    id: "access-only",
    name: "Access only",
    toolGrants: ["recall"],
    access: access({ filesystem: "read" })
  });
  h.store.setBundleEnabled("alpha", "tool-only", true, {
    expectedRevision: 1
  });
  h.store.setBundleEnabled("alpha", "access-only", true, {
    expectedRevision: 1
  });
  h.store.createProfile("alpha", {
    id: "split-authority",
    name: "Split authority",
    activeSkills: [],
    toolGrants: [],
    capabilityBundleIds: ["tool-only", "access-only"]
  });
  h.store.bindProjectProfile("alpha", "split-authority");
  const resolution = h.store.resolve("alpha", "alpha-session");
  assert.equal(resolution.access.filesystem, "read");
  assert.match(
    profileCapabilityBoundaryError({
      name: "code_read",
      source: "internal",
      sideEffects: false,
      capability: { resources: ["filesystem"] }
    }, resolution),
    /exact tool and all required access/
  );
});

test("binding CAS and authority journal corruption fail closed", (t) => {
  const h = harness(t);
  h.store.createProfile("alpha", {
    id: "first",
    name: "First",
    activeSkills: [],
    toolGrants: [],
    capabilityBundleIds: []
  });
  h.store.createProfile("alpha", {
    id: "second",
    name: "Second",
    activeSkills: [],
    toolGrants: [],
    capabilityBundleIds: []
  });
  h.store.bindProjectProfile("alpha", "first", {
    expectedBindingProfileId: null,
    expectedProfileRevision: 1
  });
  assert.throws(
    () => h.store.bindProjectProfile("alpha", "second", {
      expectedBindingProfileId: null,
      expectedProfileRevision: 1
    }),
    CapabilityProfileRevisionError
  );
  fs.appendFileSync(
    path.join(h.dataDir, "capability-profiles", "events.jsonl"),
    "{\"version\":1,\"sequence\":999",
    "utf8"
  );
  assert.throws(
    () => h.store.resolve("alpha", "alpha-session"),
    /authority journal is unavailable/
  );
  assert.throws(
    () => h.store.createProfile("alpha", {
      id: "after-corruption",
      name: "After corruption",
      activeSkills: [],
      toolGrants: [],
      capabilityBundleIds: []
    }),
    /authority journal is unavailable/
  );
});

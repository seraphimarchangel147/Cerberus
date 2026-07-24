import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CapabilityProfileStore } from "../src/capability-profile-store.js";
import { buildDefaultInstructions } from "../src/model-provider.js";
import { ProjectStore } from "../src/project-store.js";
import {
  registerCapabilityProfileTools,
  ToolRegistry
} from "../src/tool-registry.js";

const PROFILE_TOOL_NAMES = [
  "profile_list",
  "profile_get",
  "profile_create",
  "profile_update",
  "profile_activate",
  "profile_revoke",
  "capability_bundle_list",
  "capability_bundle_create",
  "capability_bundle_update",
  "capability_bundle_enable",
  "capability_bundle_revoke",
  "capability_audit",
  "skill_import_list",
  "skill_import_stage",
  "skill_import_review",
  "skill_import_approve",
  "skill_import_reject"
];

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

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-profile-tools-"));
  const dataDir = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const projects = new ProjectStore({
    dataDir,
    defaultWorkspaceRoot: workspace
  });
  projects.resolveForSession("profile-session");
  const profiles = new CapabilityProfileStore({ dataDir, projects });
  const calls = [];
  const skillImports = {
    list: () => [],
    stage: () => ({ id: "skill_import_1111111111111111" }),
    review: () => ({ candidate: null }),
    approve: () => ({ status: "approved" }),
    reject: () => ({ status: "rejected" })
  };
  const runtime = { projects, profiles, skillImports };
  const registry = new ToolRegistry();
  registry.bindProjects(projects);
  registry.bindProfiles(profiles);
  registerCapabilityProfileTools(registry, runtime);
  registry.register({
    name: "code_read",
    sideEffects: false,
    capability: {
      resources: ["filesystem"]
    },
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    handler: () => {
      calls.push("code_read");
      return { read: true };
    }
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    calls,
    context(extra = {}) {
      return {
        __projectId: "default",
        __projectRevision: projects.get("default").revision,
        agentId: "main",
        from: "test",
        sessionId: "profile-session",
        ...extra
      };
    },
    profiles,
    projects,
    registry,
    runtime
  };
}

test("all profile, grant, and quarantine tools are deferred and prompt-visible", (t) => {
  const h = harness(t);
  for (const name of PROFILE_TOOL_NAMES) {
    const descriptor = h.registry.get(name);
    assert.ok(descriptor, `${name} must be registered`);
    assert.equal(descriptor.metadata.toolSearch, "deferred");
  }
  const instructions = buildDefaultInstructions({
    agent: { name: "Capability Agent" }
  });
  for (const name of PROFILE_TOOL_NAMES) {
    assert.match(instructions, new RegExp(`\\b${name}\\b`));
  }
});

test("manual authority gates reject forged confirmation and auto-approval", async (t) => {
  const h = harness(t);
  const created = h.profiles.createBundle("default", {
    id: "read-files",
    name: "Read files",
    toolGrants: ["code_read"],
    access: access({ filesystem: "read" })
  }, { actor: "fixture" });
  assert.equal(created.status, "disabled");

  const forged = await h.registry.invoke(
    "capability_bundle_enable",
    {
      id: "read-files",
      expectedRevision: 1,
      enabled: true
    },
    h.context({ __confirmed: true })
  );
  assert.equal(forged.ok, false);
  assert.match(forged.error, /explicit human approval/i);
  assert.equal(h.profiles.getBundle("default", "read-files").status, "disabled");

  const auto = await h.registry.invoke(
    "capability_bundle_enable",
    {
      id: "read-files",
      expectedRevision: 1,
      enabled: true
    },
    h.context({
      __confirmed: true,
      __approval: { decider: "auto-approve" }
    })
  );
  assert.equal(auto.ok, false);
  assert.match(auto.error, /auto-approve is insufficient/i);

  const enabled = await h.registry.invoke(
    "capability_bundle_enable",
    {
      id: "read-files",
      expectedRevision: 1,
      enabled: true
    },
    h.context({
      __confirmed: true,
      __approval: { decider: "operator-1", via: "test" }
    })
  );
  assert.equal(enabled.ok, true);
  assert.equal(enabled.result.status, "enabled");

  const importForged = await h.registry.invoke(
    "skill_import_approve",
    {
      id: "skill_import_1111111111111111",
      expectedRevision: 1
    },
    h.context({ __confirmed: true })
  );
  assert.equal(importForged.ok, false);
  assert.match(importForged.error, /explicit human approval/i);
});

test("fresh invocation checks revoke stale profile grants before dispatch", async (t) => {
  const h = harness(t);
  h.profiles.createBundle("default", {
    id: "read-files",
    name: "Read files",
    toolGrants: ["code_read"],
    access: access({ filesystem: "read" })
  }, { actor: "operator" });
  h.profiles.setBundleEnabled("default", "read-files", true, {
    expectedRevision: 1,
    actor: "operator"
  });
  h.profiles.createProfile("default", {
    id: "reviewer",
    name: "Reviewer",
    activeSkills: [],
    toolGrants: [],
    capabilityBundleIds: ["read-files"]
  }, { actor: "operator" });
  h.profiles.bindSessionProfile(
    "default",
    "profile-session",
    "reviewer",
    { actor: "operator" }
  );

  const first = await h.registry.invoke("code_read", {}, h.context());
  assert.equal(first.ok, true);
  assert.equal(h.calls.length, 1);

  h.profiles.revokeBundle("default", "read-files", {
    expectedRevision: 2,
    actor: "operator"
  });
  const staleContext = h.context({
    __capabilityProfileResolution: {
      active: true,
      locked: false,
      profileId: "reviewer",
      toolGrants: ["code_read"],
      access: access({ filesystem: "read" })
    }
  });
  const blocked = await h.registry.invoke("code_read", {}, staleContext);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "capability_profile_denied");
  assert.match(blocked.error, /not granted|filesystem read/i);
  assert.equal(h.calls.length, 1);
});

test("profile activation is session scoped and requires human approval", async (t) => {
  const h = harness(t);
  h.profiles.createProfile("default", {
    id: "quiet",
    name: "Quiet",
    persona: "Answer briefly.",
    activeSkills: [],
    toolGrants: ["profile_list"],
    capabilityBundleIds: []
  }, { actor: "operator" });
  const activated = await h.registry.invoke(
    "profile_activate",
    {
      id: "quiet",
      scope: "session",
      expectedBindingProfileId: "",
      expectedProfileRevision: 1
    },
    h.context({
      __confirmed: true,
      __approval: { decider: "operator-1", via: "test" }
    })
  );
  assert.equal(activated.ok, true);
  assert.equal(
    h.profiles.resolve("default", "profile-session").profileId,
    "quiet"
  );
});

test("a default profile gates legacy context-free invocation", async (t) => {
  const h = harness(t);
  h.profiles.createProfile("default", {
    id: "deny-code",
    name: "Deny code",
    activeSkills: [],
    toolGrants: ["profile_list"],
    capabilityBundleIds: []
  }, { actor: "operator" });
  h.profiles.bindProjectProfile("default", "deny-code", {
    expectedBindingProfileId: null,
    expectedProfileRevision: 1,
    actor: "operator"
  });
  const advertised = h.registry.modelToolPlan({
    context: {
      agentId: "main",
      from: "legacy-test",
      sessionId: "unbound-legacy-session"
    }
  });
  assert.equal(
    advertised.tools.some((tool) => tool.name === "code_read"),
    false
  );
  const outcome = await h.registry.invoke("code_read", {}, {
    agentId: "main",
    from: "legacy-test",
    sessionId: "unbound-legacy-session"
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "capability_profile_denied");
  assert.match(outcome.error, /not granted/);
  assert.equal(h.calls.length, 0);
});

test("revocation during an asynchronous pre-hook blocks final dispatch", async (t) => {
  const h = harness(t);
  h.profiles.createBundle("default", {
    id: "read-files",
    name: "Read files",
    toolGrants: ["code_read"],
    access: access({ filesystem: "read" })
  }, { actor: "operator" });
  h.profiles.setBundleEnabled("default", "read-files", true, {
    expectedRevision: 1,
    actor: "operator"
  });
  h.profiles.createProfile("default", {
    id: "hook-race",
    name: "Hook race",
    activeSkills: [],
    toolGrants: [],
    capabilityBundleIds: ["read-files"]
  }, { actor: "operator" });
  h.profiles.bindSessionProfile(
    "default",
    "profile-session",
    "hook-race",
    {
      expectedBindingProfileId: null,
      expectedProfileRevision: 1,
      actor: "operator"
    }
  );
  let revoked = false;
  h.registry.bindHooks({
    beforeToolCall: async () => {
      if (!revoked) {
        revoked = true;
        h.profiles.revokeBundle("default", "read-files", {
          expectedRevision: 2,
          actor: "hook-test"
        });
      }
      return { action: "allow" };
    },
    notify: () => {}
  });
  const outcome = await h.registry.invoke("code_read", {}, h.context());
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "capability_profile_denied");
  assert.equal(h.calls.length, 0);
});

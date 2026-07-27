import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillRegistry } from "../src/skills.js";
import { ToolRegistry } from "../src/tool-registry.js";

const MUTATION_ARGS = Object.freeze({
  create_skill: {
    name: "blocked-created",
    description: "Must not be created outside the control plane.",
    body: "Do not create this skill."
  },
  edit_skill: {
    name: "guarded",
    body: "Mutated outside the control plane."
  },
  delete_skill: { name: "guarded" },
  pin_skill: { name: "guarded", pinned: true },
  restore_skill: { name: "guarded" }
});

function writeSkill(dir, name, { body = "Original body.", state = "active" } = {}) {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: "${name} test skill"`,
      `state: ${state}`,
      "---",
      "",
      body,
      ""
    ].join("\n")
  );
}

function makeHarness(t, { withProjectStore = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-project-skill-boundary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundled = path.join(root, "bundled");
  const user = path.join(root, "user");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(bundled, { recursive: true });
  fs.mkdirSync(user, { recursive: true });
  const projects = withProjectStore
    ? {
        get(id) {
          return {
            id,
            status: "active",
            revision: 1,
            workspaceRoot: root,
            secretRefs: [],
            activeSkills: ["*"],
            mcpGrants: [],
            hookIds: [],
            kanbanBoardId: "default",
            modelProfile: {},
            routingProfile: {},
            policy: { allowedTools: ["*"], toolPolicy: "full" }
          };
        }
      }
    : null;
  const emitted = [];
  const runtime = {
    skills: { dirs: [bundled, user] },
    tools: new ToolRegistry(),
    events: {
      emit(name, payload) {
        emitted.push({ name, payload });
      }
    },
    ...(projects ? { projects } : {})
  };
  if (projects) runtime.tools.bindProjects(projects);
  const registry = new SkillRegistry({
    runtime,
    dirs: [bundled, user],
    dataDir,
    autoLoad: false,
    warn() {}
  });
  registry.reload();
  return { emitted, registry, runtime, tools: runtime.tools, user };
}

test("nondefault projects cannot mutate global skill definitions through preflight or direct dispatch", async (t) => {
  const { registry, tools, user } = makeHarness(t);
  writeSkill(user, "guarded", { state: "stale" });
  registry.reload();
  const context = {
    __projectId: "alpha",
    __projectRevision: 1,
    __projectActiveSkills: ["*"],
    agentId: "main",
    sessionId: "project-skill-boundary"
  };

  for (const [name, args] of Object.entries(MUTATION_ARGS)) {
    const tool = tools.get(name);
    assert.throws(
      () => tool.preflight(args, context),
      (error) => error?.code === "PROJECT_BOUNDARY_VIOLATION",
      `${name} preflight must reject a nondefault project`
    );
    assert.throws(
      () => tool.handler(args, context),
      (error) => error?.code === "PROJECT_BOUNDARY_VIOLATION",
      `${name} handler must reject direct alias/replay dispatch`
    );
    const outcome = await tools.invoke(name, args, context);
    assert.equal(outcome.ok, false, `${name} must fail before policy or approval gates`);
    assert.equal(outcome.outcome.code, "preflight_error");
    assert.match(outcome.error, /default project control plane/);
  }

  assert.equal(registry.has("blocked-created"), false);
  assert.equal(registry.mustGet("guarded").body, "Original body.");
  assert.equal(registry.mustGet("guarded").pinned, false);
  assert.equal(registry.mustGet("guarded").state, "stale");
  assert.throws(
    () => tools.get("create_skill").preflight(MUTATION_ARGS.create_skill, {
      projectId: "default"
    }),
    (error) => error?.code === "PROJECT_BOUNDARY_VIOLATION",
    "a public projectId must not impersonate the private control identity"
  );
});

test("default control plane can mutate definitions independently of project skill grants", (t) => {
  const { emitted, registry, tools, user } = makeHarness(t);
  writeSkill(user, "guarded", { state: "stale" });
  writeSkill(user, "disposable");
  writeSkill(user, "rollbackable");
  registry.reload();
  const context = {
    __projectId: "default",
    __projectActiveSkills: [],
    agentId: "main",
    sessionId: "discord:guild:control-channel"
  };

  for (const [name, args] of Object.entries(MUTATION_ARGS)) {
    assert.equal(tools.get(name).preflight(args, context), true);
  }

  const created = tools.get("create_skill").handler({
    name: "control-created",
    description: "Created by the default control plane.",
    body: "A durable control-plane definition."
  }, context);
  assert.equal(created.slug, "control-created");
  tools.get("edit_skill").handler({
    name: "guarded",
    body: "Edited by the control plane."
  }, context);
  tools.get("edit_skill").handler({
    name: "guarded",
    old_string: "Edited by the control plane.",
    new_string: "Patched by the control plane."
  }, context);
  tools.get("pin_skill").handler({ name: "guarded", pinned: true }, context);
  tools.get("restore_skill").handler({ name: "guarded" }, context);
  tools.get("delete_skill").handler({ name: "disposable" }, context);
  tools.get("edit_skill").handler({
    name: "rollbackable",
    body: "Temporary revision."
  }, context);
  const rollbackRevision = registry.revisionHistory("rollbackable").revisions[0];
  tools.get("rollback_skill").handler({
    name: "rollbackable",
    revisionId: rollbackRevision.id
  }, {
    ...context,
    __projectActiveSkills: ["rollbackable"]
  });

  assert.equal(registry.mustGet("guarded").body, "Patched by the control plane.");
  assert.equal(registry.mustGet("guarded").pinned, true);
  assert.equal(registry.mustGet("guarded").state, "active");
  assert.equal(registry.has("disposable"), false);
  assert.equal(registry.mustGet("rollbackable").body, "Original body.");
  const editEvents = emitted.filter((event) => event.name === "skill-edit");
  assert.deepEqual(
    editEvents.map((event) => event.payload.action),
    [
      "created",
      "edited",
      "patched",
      "pinned",
      "restored",
      "deleted",
      "edited",
      "rolled-back"
    ]
  );
  assert.ok(
    editEvents.every(
      (event) => event.payload.sessionId === "discord:guild:control-channel"
    ),
    "every authoring tool must retain the originating session"
  );
});

test("legacy runtimes without ProjectStore keep the model-facing mutation contract", (t) => {
  const { registry, tools } = makeHarness(t, { withProjectStore: false });

  for (const [name, args] of Object.entries(MUTATION_ARGS)) {
    assert.equal(tools.get(name).preflight(args, {}), true);
  }
  const created = tools.get("create_skill").handler({
    name: "legacy-created",
    description: "Legacy embedding compatibility.",
    body: "Continue to support runtimes without ProjectStore."
  }, {});
  assert.equal(created.slug, "legacy-created");
  assert.equal(registry.has("legacy-created"), true);
});

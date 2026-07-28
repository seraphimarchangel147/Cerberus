// Skill-system Wave: frontmatter pass-through, conditional activation, bundles.
//
// Three gaps against Hermes closed here:
//   1. parseSkillDocument modelled only a fixed key set, so ANY new frontmatter
//      key was silently dropped — every future feature needed parser surgery.
//      Now unknown keys survive on `skill.meta`.
//   2. Conditional activation: `requires_tools` hides a skill whose hard
//      dependencies are absent; `fallback_for_tools` hides a skill while its
//      PRIMARY tools are present, surfacing it only during an outage.
//   3. Bundles: one alias loads several skills in a single use_skill call,
//      with cycle detection and a depth cap.
//
// The load-bearing invariant across all three: a skill that declares NOTHING
// behaves exactly as before. Regression here silently hides procedural
// knowledge, which is worse than showing too much — hence the fail-open tests.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SkillRegistry } from "../src/skills.js";

function writeSkill(dir, name, frontmatterLines = [], body = `Body for ${name}.`) {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  const lines = [`name: ${name}`, `description: desc for ${name}`, ...frontmatterLines];
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\n${lines.join("\n")}\n---\n\n${body}\n`,
    "utf8"
  );
}

function tempDir(prefix = "openagi-skill-wave-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A minimal stand-in for the real ToolRegistry: availableSkillToolNames only
// reads `runtime.tools.tools` as a Map of names.
function runtimeWithTools(names) {
  if (names === null) return { tools: null };
  const registered = new Map();
  return {
    tools: {
      tools: new Map(names.map((n) => [n, { name: n }])),
      register: (spec) => registered.set(spec.name, spec),
      unregister: (name) => registered.delete(name)
    }
  };
}

function registryFor(dir, runtime = {}) {
  return new SkillRegistry({
    runtime,
    dirs: [dir],
    dataDir: tempDir("openagi-skill-wave-data-"),
    warn: () => {}
  });
}

// MARK: — 1. generic frontmatter pass-through

test("unknown frontmatter keys survive on skill.meta instead of being dropped", () => {
  const dir = tempDir();
  writeSkill(dir, "passthrough-skill", [
    "category: devops",
    'author: "seraphim"',
    "risk_level: high",
    'tags: ["a","b"]'
  ]);
  const view = registryFor(dir).view("passthrough-skill");

  // Modelled keys still land in their typed homes...
  assert.equal(view.category, "devops");
  // ...and unmodelled keys are preserved rather than voided.
  assert.equal(view.meta.author, "seraphim");
  assert.equal(view.meta.risk_level, "high");
  assert.deepEqual(view.meta.tags, ["a", "b"]);
  // Known keys must NOT be duplicated into meta.
  assert.equal(view.meta.category, undefined);
  assert.equal(view.meta.name, undefined);
});

test("a skill declaring no new metadata is completely unchanged", () => {
  const dir = tempDir();
  writeSkill(dir, "legacy-skill");
  const registry = registryFor(dir, runtimeWithTools(["terminal"]));
  const view = registry.view("legacy-skill");

  assert.deepEqual(view.meta, {});
  assert.equal(view.requiresTools, null);
  assert.equal(view.fallbackForTools, null);
  assert.equal(view.bundle, null);
  assert.equal(registry.isActivatedFor(registry.mustGet("legacy-skill")), true);
  assert.match(registry.promptIndex(), /- legacy-skill:/);
});

// MARK: — 2. conditional activation

test("requires_tools hides a skill when a hard dependency is absent", () => {
  const dir = tempDir();
  writeSkill(dir, "needs-browser", ['requires_tools: ["browser_navigate"]']);

  const withTool = registryFor(dir, runtimeWithTools(["browser_navigate", "terminal"]));
  assert.equal(withTool.isActivatedFor(withTool.mustGet("needs-browser")), true);
  assert.match(withTool.promptIndex(), /- needs-browser:/);

  const withoutTool = registryFor(dir, runtimeWithTools(["terminal"]));
  assert.equal(withoutTool.isActivatedFor(withoutTool.mustGet("needs-browser")), false);
  assert.doesNotMatch(withoutTool.promptIndex(), /needs-browser/);

  const why = withoutTool.activationFor(withoutTool.mustGet("needs-browser"));
  assert.equal(why.reason, "requires-missing-tools");
  assert.deepEqual(why.missingTools, ["browser_navigate"]);
});

test("requires_tools needs EVERY declared tool, not just one", () => {
  const dir = tempDir();
  writeSkill(dir, "needs-both", ['requires_tools: ["alpha","beta"]']);
  const partial = registryFor(dir, runtimeWithTools(["alpha"]));
  assert.equal(partial.isActivatedFor(partial.mustGet("needs-both")), false);

  const full = registryFor(dir, runtimeWithTools(["alpha", "beta"]));
  assert.equal(full.isActivatedFor(full.mustGet("needs-both")), true);
});

test("fallback_for_tools inverts: the skill appears only during a primary outage", () => {
  const dir = tempDir();
  writeSkill(dir, "ddg-fallback", ['fallback_for_tools: ["web_search"]']);

  // Primary present => fallback stays hidden.
  const healthy = registryFor(dir, runtimeWithTools(["web_search"]));
  assert.equal(healthy.isActivatedFor(healthy.mustGet("ddg-fallback")), false);
  assert.doesNotMatch(healthy.promptIndex(), /ddg-fallback/);
  const why = healthy.activationFor(healthy.mustGet("ddg-fallback"));
  assert.equal(why.reason, "primary-tools-available");
  assert.deepEqual(why.supersededBy, ["web_search"]);

  // Primary gone => fallback surfaces automatically.
  const outage = registryFor(dir, runtimeWithTools(["terminal"]));
  assert.equal(outage.isActivatedFor(outage.mustGet("ddg-fallback")), true);
  assert.match(outage.promptIndex(), /- ddg-fallback:/);
});

test("fallback_for_toolsets is accepted as an alias for fallback_for_tools", () => {
  const dir = tempDir();
  writeSkill(dir, "alias-skill", ['fallback_for_toolsets: ["web_search"]']);
  const registry = registryFor(dir, runtimeWithTools(["web_search"]));
  assert.deepEqual(registry.mustGet("alias-skill").fallbackForTools, ["web_search"]);
  assert.equal(registry.isActivatedFor(registry.mustGet("alias-skill")), false);
});

test("activation FAILS OPEN when the tool registry is unreadable", () => {
  // Hiding procedural knowledge because a probe failed is worse than showing
  // an extra skill, so an unreadable registry must not gate anything.
  const dir = tempDir();
  writeSkill(dir, "needs-browser", ['requires_tools: ["browser_navigate"]']);
  const registry = registryFor(dir, runtimeWithTools(null));
  assert.equal(registry.isActivatedFor(registry.mustGet("needs-browser")), true);
  assert.match(registry.promptIndex(), /- needs-browser:/);
});

test("list_skills hides gated skills but can reveal them with include_inactive", () => {
  const dir = tempDir();
  writeSkill(dir, "needs-browser", ['requires_tools: ["browser_navigate"]']);
  writeSkill(dir, "always-on");

  const registered = new Map();
  const toolRegistry = {
    tools: new Map([["terminal", { name: "terminal" }]]),
    register: (spec) => registered.set(spec.name, spec),
    unregister: (name) => registered.delete(name)
  };
  const registry = new SkillRegistry({
    runtime: { tools: toolRegistry },
    dirs: [dir],
    dataDir: tempDir("openagi-skill-wave-data-"),
    warn: () => {}
  });

  const listSkills = registered.get("list_skills");
  assert.ok(listSkills, "list_skills must be registered");

  const visible = listSkills.handler({}, {}).map((s) => s.name);
  assert.deepEqual(visible, ["always-on"]);

  const all = listSkills.handler({ include_inactive: true }, {});
  const gated = all.find((s) => s.name === "needs-browser");
  assert.equal(gated.active, false);
  assert.equal(gated.inactiveReason, "requires-missing-tools");
});

// MARK: — 3. bundles

test("use_skill on a bundle alias loads every member in declared order", () => {
  const dir = tempDir();
  writeSkill(dir, "tdd-thing");
  writeSkill(dir, "pr-thing");
  writeSkill(dir, "backend-dev", ['bundle: ["tdd-thing","pr-thing"]'], "Bundle alias.");

  const registered = new Map();
  const registry = new SkillRegistry({
    runtime: {
      tools: {
        tools: new Map(),
        register: (spec) => registered.set(spec.name, spec),
        unregister: (name) => registered.delete(name)
      }
    },
    dirs: [dir],
    dataDir: tempDir("openagi-skill-wave-data-"),
    warn: () => {}
  });

  const result = registered.get("use_skill").handler({ name: "backend-dev" }, {});
  assert.equal(result.bundle, "backend-dev");
  assert.equal(result.memberCount, 2);
  assert.deepEqual(result.skills.map((s) => s.name), ["tdd-thing", "pr-thing"]);
  // Bodies actually come along — a bundle that returns names only is useless.
  assert.match(result.skills[0].body, /Body for tdd-thing\./);

  // A plain skill still returns the single-skill shape.
  const single = registered.get("use_skill").handler({ name: "tdd-thing" }, {});
  assert.equal(single.bundle, null);
  assert.equal(single.name, "tdd-thing");
});

test("nested bundles flatten and de-duplicate shared members", () => {
  const dir = tempDir();
  writeSkill(dir, "leaf-a");
  writeSkill(dir, "leaf-b");
  writeSkill(dir, "inner", ['bundle: ["leaf-a","leaf-b"]']);
  writeSkill(dir, "outer", ['bundle: ["inner","leaf-a"]']);

  const expansion = registryFor(dir).expandBundle("outer");
  assert.deepEqual(expansion.members, ["leaf-a", "leaf-b"]);
  assert.deepEqual(expansion.cycles, []);
});

test("a bundle cycle is reported, not hung on", () => {
  const dir = tempDir();
  writeSkill(dir, "loop-a", ['bundle: ["loop-b"]']);
  writeSkill(dir, "loop-b", ['bundle: ["loop-a"]']);

  const expansion = registryFor(dir).expandBundle("loop-a");
  assert.ok(expansion.cycles.length > 0, "cycle must be reported");
  assert.deepEqual(expansion.members, []);
});

test("a bundle referencing a missing skill reports it instead of throwing", () => {
  const dir = tempDir();
  writeSkill(dir, "leaf-a");
  writeSkill(dir, "partial", ['bundle: ["leaf-a","ghost-skill"]']);

  const expansion = registryFor(dir).expandBundle("partial");
  assert.deepEqual(expansion.members, ["leaf-a"]);
  assert.deepEqual(expansion.missing, ["ghost-skill"]);
});

test("bundle expansion is depth-capped", () => {
  const dir = tempDir();
  writeSkill(dir, "leaf");
  let previous = "leaf";
  for (let i = 0; i < 8; i += 1) {
    const name = `chain-${i}`;
    writeSkill(dir, name, [`bundle: ["${previous}"]`]);
    previous = name;
  }
  assert.throws(
    () => registryFor(dir).expandBundle(previous),
    /exceeds max expansion depth/
  );
});

test("malformed activation and bundle metadata is rejected at parse time", () => {
  const dir = tempDir();
  writeSkill(dir, "bad-bundle", ['bundle: ["Not A Slug"]']);
  writeSkill(dir, "bad-requires", ["requires_tools: [123]"]);
  writeSkill(dir, "good-skill");

  const registry = registryFor(dir);
  // Invalid skills are skipped with a diagnostic; the valid one still loads.
  const names = registry.list().map((s) => s.name);
  assert.deepEqual(names, ["good-skill"]);
  const reasons = registry.getDiagnostics().map((d) => d.reason).join(" | ");
  assert.match(reasons, /bundle entries must be lowercase kebab-case/);
  assert.match(reasons, /requires_tools entries must be non-empty/);
});

test("promptIndex marks bundles so the model knows one call loads many", () => {
  const dir = tempDir();
  writeSkill(dir, "tdd-thing");
  writeSkill(dir, "pr-thing");
  writeSkill(dir, "backend-dev", ['bundle: ["tdd-thing","pr-thing"]']);
  const index = registryFor(dir).promptIndex();
  assert.match(index, /- backend-dev \(bundle: tdd-thing, pr-thing\):/);
});

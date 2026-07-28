// Block-aware frontmatter: the actual defect behind the skill-system wave.
//
// `parseFrontmatter` was a hand-rolled `key: value` line splitter. Any YAML
// block construct — the block sequence form that stock Hermes/Anthropic
// skills use routinely — did not merely get skipped, it threw and took the
// ENTIRE skill down ("expected key: value"). That made importing externally
// authored skills wholesale impossible.
//
// Two things had to land together, in order:
//   1. WRITER first. `updateFrontmatter` was line-oriented: it found the
//      `key:` line and replaced/deleted only THAT line. Against a multi-line
//      value it would strand the continuation lines as orphaned garbage that
//      the parser then rejects. Shipping the parser alone would have created
//      documents the writer corrupts on the next curator write.
//   2. PARSER second, now that round-tripping is safe.
//
// Load-bearing invariant, same as the previous wave: a skill using only the
// historical inline form is parsed byte-identically to before.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SkillRegistry, updateFrontmatter } from "../src/skills.js";

function tempDir(prefix = "openagi-fm-block-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeRaw(dir, name, frontmatter, body = `Body for ${name}.`) {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
  return path.join(skillDir, "SKILL.md");
}

// Load a single skill through the REAL registry rather than poking a private
// parser, so these tests fail if the wiring in between regresses too.
// SkillRegistry loads in its constructor; diagnostics carry `.reason`.
function loadOne(frontmatter, body) {
  const dir = tempDir();
  writeRaw(dir, "probe-skill", frontmatter, body);
  const registry = new SkillRegistry({
    dirs: [dir],
    dataDir: tempDir("openagi-fm-block-data-"),
    warn: () => {}
  });
  const diagnostics = registry.getDiagnostics();
  // mustGet (not view) — view() projects a public subset that omits
  // systemPrompt, and these tests assert on the full parsed record.
  const skill = registry.list().some((s) => s.name === "probe-skill")
    ? registry.mustGet("probe-skill")
    : undefined;
  return { skill, diagnostics, dir, registry };
}

// Write an already-rendered SKILL.md and assert it still loads clean.
function reloadDocument(document) {
  const dir = tempDir();
  const skillDir = path.join(dir, "probe-skill");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), document, "utf8");
  const registry = new SkillRegistry({
    dirs: [dir],
    dataDir: tempDir("openagi-fm-block-data-"),
    warn: () => {}
  });
  assert.deepEqual(registry.getDiagnostics(), [], "rewritten document must still parse");
  return registry.mustGet("probe-skill");
}

// --- 1. The reported defect: block sequences ------------------------------

test("block-sequence requires_tools loads instead of killing the skill", () => {
  const { skill, diagnostics } = loadOne(
    [
      "name: probe-skill",
      "description: probe",
      "requires_tools:",
      "  - browser_navigate",
      "  - browser_click"
    ].join("\n")
  );
  assert.deepEqual(diagnostics, [], "block list must not produce a load diagnostic");
  assert.ok(skill, "skill must load");
  assert.deepEqual(skill.requiresTools, ["browser_navigate", "browser_click"]);
});

test("block and flow sequence forms are equivalent", () => {
  const block = loadOne(
    ["name: probe-skill", "description: probe", "bundle:", "  - alpha", "  - beta"].join("\n")
  ).skill;
  const flow = loadOne(
    ["name: probe-skill", "description: probe", 'bundle: ["alpha", "beta"]'].join("\n")
  ).skill;
  assert.deepEqual(block.bundle, flow.bundle);
  assert.deepEqual(block.bundle, ["alpha", "beta"]);
});

test("quoted and unquoted block-sequence items both parse", () => {
  const { skill } = loadOne(
    [
      "name: probe-skill",
      "description: probe",
      "requires_tools:",
      '  - "quoted_tool"',
      "  - 'single_quoted'",
      "  - bare_tool"
    ].join("\n")
  );
  assert.deepEqual(skill.requiresTools, ["quoted_tool", "single_quoted", "bare_tool"]);
});

test("a block sequence on an UNKNOWN key survives on skill.meta", () => {
  const { skill } = loadOne(
    ["name: probe-skill", "description: probe", "tags:", "  - research", "  - browser"].join("\n")
  );
  assert.deepEqual(skill.meta.tags, ["research", "browser"]);
});

// --- 2. Block scalars -----------------------------------------------------

test("literal block scalar preserves newlines, folded joins lines", () => {
  const { skill } = loadOne(
    [
      "name: probe-skill",
      "description: probe",
      "systemPrompt: |",
      "  line one",
      "  line two",
      "notes: >",
      "  folded one",
      "  folded two"
    ].join("\n")
  );
  assert.equal(skill.systemPrompt, "line one\nline two\n");
  assert.equal(skill.meta.notes, "folded one folded two\n");
});

test("block scalar chomping: strip, clip, keep", () => {
  const { skill } = loadOne(
    [
      "name: probe-skill",
      "description: probe",
      "stripped: |-",
      "  a",
      "clipped: |",
      "  b",
      "kept: |+",
      "  c",
      ""
    ].join("\n")
  );
  assert.equal(skill.meta.stripped, "a", "strip removes the trailing newline");
  assert.equal(skill.meta.clipped, "b\n", "clip keeps exactly one");
  assert.equal(skill.meta.kept, "c\n\n", "keep retains the extra blank");
});

test("indentation inside a literal block scalar is preserved relative to the block", () => {
  const { skill } = loadOne(
    [
      "name: probe-skill",
      "description: probe",
      "snippet: |",
      "  def f():",
      "      return 1"
    ].join("\n")
  );
  assert.equal(skill.meta.snippet, "def f():\n    return 1\n");
});

test("a colon inside a block scalar is not treated as a key", () => {
  const { skill } = loadOne(
    [
      "name: probe-skill",
      "description: probe",
      "snippet: |",
      "  http://example.com",
      "  key: not-a-real-key"
    ].join("\n")
  );
  assert.equal(skill.meta.snippet, "http://example.com\nkey: not-a-real-key\n");
  assert.ok(!Object.hasOwn(skill.meta, "key"), "the nested colon must not leak a top-level key");
});

// --- 3. Nested mappings ---------------------------------------------------

test("nested block mapping parses into an object", () => {
  const { skill } = loadOne(
    [
      "name: probe-skill",
      "description: probe",
      "owner:",
      "  name: seraphim",
      "  role: archangel"
    ].join("\n")
  );
  assert.deepEqual(skill.meta.owner, { name: "seraphim", role: "archangel" });
});

test("a sequence of mappings parses into an array of objects", () => {
  const { skill } = loadOne(
    [
      "name: probe-skill",
      "description: probe",
      "steps:",
      "  - id: one",
      "    label: first",
      "  - id: two",
      "    label: second"
    ].join("\n")
  );
  assert.deepEqual(skill.meta.steps, [
    { id: "one", label: "first" },
    { id: "two", label: "second" }
  ]);
});

// --- 4. Backward compatibility (the load-bearing invariant) ---------------

test("inline frontmatter parses exactly as before", () => {
  const { skill } = loadOne(
    [
      "name: probe-skill",
      'description: "a quoted description"',
      "category: research",
      "pinned: true",
      'allowed_tools: ["read_file"]',
      "# a comment line",
      "custom: plain value"
    ].join("\n")
  );
  assert.equal(skill.description, "a quoted description");
  assert.equal(skill.category, "research");
  assert.equal(skill.pinned, true);
  assert.deepEqual(skill.allowedTools, ["read_file"]);
  assert.equal(skill.meta.custom, "plain value");
});

test("duplicate top-level keys are still rejected", () => {
  const { skill, diagnostics } = loadOne(
    ["name: probe-skill", "description: one", "description: two"].join("\n")
  );
  assert.equal(skill, undefined);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].reason, /duplicate frontmatter key/);
});

test("a genuinely malformed line is still rejected with its line number", () => {
  const { skill, diagnostics } = loadOne(
    ["name: probe-skill", "description: probe", "this line has no colon"].join("\n")
  );
  assert.equal(skill, undefined);
  assert.match(diagnostics[0].reason, /line 3/);
});

// --- 5. Writer round-trip: the sequencing constraint ----------------------

test("updateFrontmatter replaces a BLOCK value without stranding its lines", () => {
  const original = [
    "---",
    "name: probe-skill",
    "description: probe",
    "requires_tools:",
    "  - alpha",
    "  - beta",
    "category: research",
    "---",
    "",
    "Body.",
    ""
  ].join("\n");

  const next = updateFrontmatter(original, { requires_tools: ["gamma"] });

  assert.ok(!next.includes("- alpha"), "old block items must be gone, not orphaned");
  assert.ok(!next.includes("- beta"));
  assert.ok(next.includes("category: research"), "unrelated keys survive");

  // And critically: the result must still PARSE. This is the assertion that
  // would have failed had the parser shipped without the writer.
  assert.deepEqual(reloadDocument(next).requiresTools, ["gamma"]);
});

test("updateFrontmatter deletes a BLOCK value entirely", () => {
  const original = [
    "---",
    "name: probe-skill",
    "description: probe",
    "bundle:",
    "  - alpha",
    "  - beta",
    "category: research",
    "---",
    "",
    "Body.",
    ""
  ].join("\n");

  const next = updateFrontmatter(original, { bundle: null });
  assert.ok(!next.includes("bundle:"));
  assert.ok(!next.includes("- alpha"), "continuation lines must be removed with the key");
  assert.ok(next.includes("category: research"));
});

test("updateFrontmatter does not match a NESTED key of the same name", () => {
  const original = [
    "---",
    "name: probe-skill",
    "description: probe",
    "owner:",
    "  category: nested-value",
    "category: top-level-value",
    "---",
    "",
    "Body.",
    ""
  ].join("\n");

  const next = updateFrontmatter(original, { category: "replaced" });
  assert.ok(next.includes("  category: nested-value"), "the nested key must be untouched");
  assert.ok(next.includes('category: "replaced"'));
  assert.ok(!next.includes("category: top-level-value"));
});

test("a block scalar survives an unrelated updateFrontmatter write", () => {
  const original = [
    "---",
    "name: probe-skill",
    "description: probe",
    "systemPrompt: |",
    "  line one",
    "  line two",
    "---",
    "",
    "Body.",
    ""
  ].join("\n");

  const next = updateFrontmatter(original, { category: "research" });
  assert.ok(next.includes("  line one"), "untouched block scalar is preserved verbatim");
  assert.ok(next.includes("  line two"));

  const skill = reloadDocument(next);
  assert.equal(skill.systemPrompt, "line one\nline two\n");
  assert.equal(skill.category, "research");
});

// --- 6. Resource bounds ---------------------------------------------------

test("absurdly nested frontmatter is refused rather than blowing the stack", () => {
  const lines = ["name: probe-skill", "description: probe", "deep:"];
  for (let i = 1; i <= 10; i += 1) lines.push(`${"  ".repeat(i)}k${i}:`);
  lines.push(`${"  ".repeat(11)}leaf: value`);
  const { skill, diagnostics } = loadOne(lines.join("\n"));
  assert.equal(skill, undefined);
  assert.match(diagnostics[0].reason, /too deep/);
});

test("an over-long block sequence is refused", () => {
  const lines = ["name: probe-skill", "description: probe", "tags:"];
  for (let i = 0; i < 300; i += 1) lines.push(`  - tag-${i}`);
  const { skill, diagnostics } = loadOne(lines.join("\n"));
  assert.equal(skill, undefined);
  assert.match(diagnostics[0].reason, /exceeds 256 items/);
});

// --- 7. YAML flow sequences that are NOT valid JSON -----------------------
//
// Found by running the parser against the REAL third-party Hermes skill
// library (211 skills) rather than synthetic fixtures. The single biggest
// blocker was not block sequences at all: it was `platforms: [linux, macos]`
// — valid YAML, invalid JSON — which the `[` => JSON.parse assumption
// rejected outright, killing 76 skills. Corpus went 56 -> 202 clean once
// the flow reader landed; the 9 still failing have no frontmatter fences at
// all and are correctly refused.

test("unquoted YAML flow sequence parses (the 76-skill blocker)", () => {
  const { skill, diagnostics } = loadOne(
    ["name: probe-skill", "description: probe", "platforms: [linux, macos, windows]"].join("\n")
  );
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(skill.meta.platforms, ["linux", "macos", "windows"]);
});

test("flow sequences mixing quoted and bare scalars parse", () => {
  const { skill } = loadOne(
    ["name: probe-skill", "description: probe", 'tags: [research, "wiki", \'notes\']'].join("\n")
  );
  assert.deepEqual(skill.meta.tags, ["research", "wiki", "notes"]);
});

test("flow scalars resolve booleans, numbers and null like the JSON path", () => {
  const { skill } = loadOne(
    ["name: probe-skill", "description: probe", "mixed: [true, false, 42, 1.5, null, plain]"].join("\n")
  );
  assert.deepEqual(skill.meta.mixed, [true, false, 42, 1.5, null, "plain"]);
});

test("unquoted flow mapping and nesting parse", () => {
  const { skill } = loadOne(
    ["name: probe-skill", "description: probe", "req: {bins: [codex, tmux], safe: true}"].join("\n")
  );
  assert.deepEqual(skill.meta.req, { bins: ["codex", "tmux"], safe: true });
});

test("strict JSON still takes the fast path unchanged", () => {
  const { skill } = loadOne(
    ["name: probe-skill", "description: probe", 'tags: ["a", "b"]', 'obj: {"k": "v"}'].join("\n")
  );
  assert.deepEqual(skill.meta.tags, ["a", "b"]);
  assert.deepEqual(skill.meta.obj, { k: "v" });
});

test("deeply nested real-world metadata block round-trips", () => {
  const { skill } = loadOne(
    [
      "name: probe-skill",
      "description: probe",
      "metadata:",
      "  hermesagent:",
      "    emoji: link",
      "    requires:",
      '      bins: ["codex", "tmux"]'
    ].join("\n")
  );
  assert.deepEqual(skill.meta.metadata, {
    hermesagent: { emoji: "link", requires: { bins: ["codex", "tmux"] } }
  });
});

test("a genuinely broken flow collection is still refused", () => {
  const { skill, diagnostics } = loadOne(
    ["name: probe-skill", "description: probe", "bad: [a, b"].join("\n")
  );
  assert.equal(skill, undefined);
  assert.match(diagnostics[0].reason, /invalid flow value/);
});

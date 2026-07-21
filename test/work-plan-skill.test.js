import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SkillRegistry } from "../src/skills.js";

test("bundled work-plan skill parses and loads for in-context use", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-work-plan-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "examples", "skills");
  const runtime = { outcomes: { byRef: () => [] } };
  const skills = new SkillRegistry({ runtime, dirs: [root], dataDir });

  assert.equal(skills.has("work-plan"), true);
  const loaded = skills.view("work-plan");
  assert.equal(loaded.name, "work-plan");
  assert.match(loaded.description, /implementation plan/i);
  assert.match(loaded.body, /exact file path/i);
  assert.match(loaded.body, /verification command/i);
  assert.match(loaded.body, /Task to plan: \{\{input\}\}/);
  assert.equal(loaded.bundled, true);
});

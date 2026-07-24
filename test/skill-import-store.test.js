import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectStore } from "../src/project-store.js";
import {
  SkillImportBoundaryError,
  SkillImportRevisionError,
  SkillImportStore
} from "../src/skill-import-store.js";
import { SkillRegistry } from "../src/skills.js";

function skillDocument(name = "safe-review") {
  return `---
name: ${name}
description: "Review a bounded package safely."
allowed_tools: ["code_read"]
---

1. Read the requested file.
2. Report the result.
`;
}

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-skill-import-"));
  const dataDir = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  const bundled = path.join(root, "bundled");
  const userSkills = path.join(root, "user-skills");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(bundled, { recursive: true });
  fs.mkdirSync(userSkills, { recursive: true });
  const projects = new ProjectStore({
    dataDir,
    defaultWorkspaceRoot: workspace
  });
  const runtime = {};
  runtime.skills = new SkillRegistry({
    runtime,
    dirs: [bundled, userSkills],
    dataDir
  });
  const store = new SkillImportStore({
    dataDir,
    projects,
    runtime
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    bundled,
    dataDir,
    projects,
    root,
    runtime,
    store,
    userSkills,
    workspace
  };
}

function createGitSkill(root, {
  name = "safe-review",
  script = "process.exitCode = 99;\n"
} = {}) {
  const source = path.join(root, `${name}-repo`);
  fs.mkdirSync(path.join(source, ".git"), { recursive: true });
  fs.mkdirSync(path.join(source, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(source, "references"), { recursive: true });
  fs.writeFileSync(path.join(source, "SKILL.md"), skillDocument(name));
  fs.writeFileSync(path.join(source, "scripts", "helper.js"), script);
  fs.writeFileSync(path.join(source, "references", "guide.md"), "# Guide\n");
  return source;
}

test("local Git imports remain inert until exact human-approved materialization", (t) => {
  const h = harness(t);
  const source = createGitSkill(h.workspace);
  const marker = path.join(h.root, "must-not-exist");
  fs.writeFileSync(
    path.join(source, "scripts", "helper.js"),
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`
  );

  const staged = h.store.stage({
    projectId: "default",
    kind: "git",
    sourcePath: path.relative(h.workspace, source),
    sourceLabel: "fixture checkout"
  }, { actor: "operator:stage" });
  assert.equal(staged.status, "pending");
  assert.equal(staged.skillName, "safe-review");
  assert.equal(h.runtime.skills.has("safe-review"), false);
  assert.equal(fs.existsSync(path.join(h.userSkills, "safe-review")), false);
  assert.equal(fs.existsSync(marker), false);

  const review = h.store.review(staged.id, {
    projectId: "default",
    file: "SKILL.md"
  });
  assert.match(review.warning, /untrusted review data/i);
  assert.match(review.file.content, /allowed_tools/);
  assert.equal(fs.existsSync(marker), false);

  assert.throws(
    () => h.store.approve(staged.id, {
      projectId: "default",
      expectedRevision: 2
    }, { actor: "operator" }),
    SkillImportRevisionError
  );
  const approved = h.store.approve(staged.id, {
    projectId: "default",
    expectedRevision: 1
  }, { actor: "operator:approve" });
  assert.equal(approved.status, "approved");
  assert.equal(approved.loaded, true);
  assert.equal(h.runtime.skills.has("safe-review"), true);
  assert.equal(fs.existsSync(marker), false);

  const loaded = h.runtime.skills.mustGet("safe-review");
  assert.deepEqual(loaded.allowedTools, ["code_read"]);
  assert.equal(
    fs.readFileSync(path.join(loaded.dir, "scripts", "helper.js"), "utf8")
      .includes("writeFileSync"),
    true
  );

  const reloaded = new SkillImportStore({
    dataDir: h.dataDir,
    projects: h.projects,
    runtime: h.runtime
  });
  assert.equal(
    reloaded.get(staged.id, { projectId: "default" }).status,
    "approved"
  );
});

test("bounded ZIP imports validate CRC, root, and traversal before quarantine", (t) => {
  const h = harness(t);
  const archive = zipArchive([
    {
      name: "package/SKILL.md",
      content: Buffer.from(skillDocument("zip-review"))
    },
    {
      name: "package/references/checklist.md",
      content: Buffer.from("# Checklist\n")
    }
  ]);
  const archivePath = path.join(h.workspace, "skill.zip");
  fs.writeFileSync(archivePath, archive);
  const staged = h.store.stage({
    projectId: "default",
    kind: "zip",
    sourcePath: "skill.zip"
  }, { actor: "operator" });
  assert.equal(staged.skillName, "zip-review");
  assert.deepEqual(
    staged.manifest.map((entry) => entry.path),
    ["references/checklist.md", "SKILL.md"]
  );
  assert.equal(h.runtime.skills.has("zip-review"), false);

  const traversalPath = path.join(h.workspace, "traversal.zip");
  fs.writeFileSync(traversalPath, zipArchive([
    {
      name: "../SKILL.md",
      content: Buffer.from(skillDocument("escape"))
    }
  ]));
  assert.throws(
    () => h.store.stage({
      projectId: "default",
      kind: "zip",
      sourcePath: "traversal.zip"
    }),
    SkillImportBoundaryError
  );

  const corrupt = Buffer.from(archive);
  const firstPayload = 30 + Buffer.byteLength("package/SKILL.md");
  corrupt[firstPayload] ^= 0xff;
  fs.writeFileSync(path.join(h.workspace, "corrupt.zip"), corrupt);
  assert.throws(
    () => h.store.stage({
      projectId: "default",
      kind: "zip",
      sourcePath: "corrupt.zip"
    }),
    /CRC|size/
  );
});

test("imports are default-control-plane only and reject symlinks and collisions", (t) => {
  const h = harness(t);
  const source = createGitSkill(h.workspace, { name: "collision" });
  h.projects.create({ id: "alpha", name: "Alpha" });
  assert.throws(
    () => h.store.stage({
      projectId: "alpha",
      kind: "git",
      sourcePath: "."
    }),
    SkillImportBoundaryError
  );

  const staged = h.store.stage({
    projectId: "default",
    kind: "git",
    sourcePath: path.relative(h.workspace, source)
  }, { actor: "operator" });
  fs.mkdirSync(path.join(h.userSkills, "collision"));
  assert.throws(
    () => h.store.approve(staged.id, {
      projectId: "default",
      expectedRevision: 1
    }, { actor: "operator" }),
    /already exists/
  );

  const symlinkSource = path.join(h.workspace, "symlink-repo");
  fs.mkdirSync(path.join(symlinkSource, ".git"), { recursive: true });
  fs.writeFileSync(path.join(symlinkSource, "SKILL.md"), skillDocument("linked"));
  try {
    fs.symlinkSync(
      path.join(source, "references"),
      path.join(symlinkSource, "references"),
      "junction"
    );
  } catch {
    return;
  }
  assert.throws(
    () => h.store.stage({
      projectId: "default",
      kind: "git",
      sourcePath: path.relative(h.workspace, symlinkSource)
    }),
    SkillImportBoundaryError
  );
});

test("rejected imports remain auditable and cannot later activate", (t) => {
  const h = harness(t);
  const source = createGitSkill(h.workspace, { name: "rejected-skill" });
  const staged = h.store.stage({
    projectId: "default",
    kind: "git",
    sourcePath: path.relative(h.workspace, source)
  }, { actor: "operator" });
  const rejected = h.store.reject(staged.id, {
    projectId: "default",
    expectedRevision: 1,
    reason: "The requested permissions are too broad."
  }, { actor: "operator" });
  assert.equal(rejected.status, "rejected");
  assert.throws(
    () => h.store.approve(staged.id, {
      projectId: "default",
      expectedRevision: 2
    }, { actor: "operator" }),
    /cannot be approved/
  );
  assert.equal(h.runtime.skills.has("rejected-skill"), false);
  const events = h.store.history({ projectId: "default" });
  assert.equal(events[0].op, "reject");
  assert.ok(events.every((event) => !Object.hasOwn(event, "state")));
});

test("approval pins project revision and a corrupt import journal fails closed", (t) => {
  const h = harness(t);
  const source = createGitSkill(h.workspace, { name: "pinned-import" });
  const staged = h.store.stage({
    projectId: "default",
    kind: "git",
    sourcePath: path.relative(h.workspace, source)
  }, { actor: "operator" });
  const project = h.projects.get("default");
  h.projects.update("default", {
    expectedRevision: project.revision,
    instructions: "Changed after staging."
  }, { actor: "test" });
  assert.throws(
    () => h.store.approve(staged.id, {
      projectId: "default",
      expectedRevision: 1
    }, { actor: "operator" }),
    /changed after this skill import was staged/
  );
  fs.appendFileSync(
    path.join(h.dataDir, "skill-imports", "events.jsonl"),
    "{\"version\":1,\"sequence\":999",
    "utf8"
  );
  assert.throws(
    () => h.store.list({ projectId: "default" }),
    /authority journal is unavailable/
  );
  assert.throws(
    () => h.store.reject(staged.id, {
      projectId: "default",
      expectedRevision: 1,
      reason: "corrupt journal"
    }),
    /authority journal is unavailable/
  );
});

function zipArchive(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const content = Buffer.from(entry.content);
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0x81a40000, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + content.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

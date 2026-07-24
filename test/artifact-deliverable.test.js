import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  scanDeliverables,
  stripDeliveredPaths
} from "../src/deliverable.js";

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-artifact-delivery-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("pinned Markdown and data artifacts become deterministic attachments", () => {
  const markdownRef = "artifact:artifact_0123456789abcdef@3";
  const dataRef = "artifact:artifact_fedcba9876543210@7";
  const calls = [];
  const text = `Review ${markdownRef}, again ${markdownRef}, and ${dataRef}.`;
  const candidates = scanDeliverables(text, {
    projectId: "project-a",
    resolveArtifact(ref, context) {
      calls.push({ ref, context });
      if (ref === markdownRef) {
        return {
          id: "artifact_0123456789abcdef",
          revision: 3,
          kind: "markdown",
          title: "Launch brief",
          content: "# Launch\n"
        };
      }
      return {
        id: "artifact_fedcba9876543210",
        revision: 7,
        kind: "data",
        title: "Metrics",
        content: { z: 1, a: { y: true, x: false } }
      };
    }
  });

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].filename, "Launch brief.md");
  assert.equal(candidates[0].mimeType, "text/markdown");
  assert.equal(candidates[0].occurrences.length, 2);
  assert.equal(candidates[0].buffer.toString(), "# Launch\n");
  assert.equal(candidates[1].filename, "Metrics.json");
  assert.equal(candidates[1].mimeType, "application/json");
  assert.equal(
    candidates[1].buffer.toString(),
    "{\"a\":{\"x\":false,\"y\":true},\"z\":1}\n"
  );
  assert.deepEqual(calls, [
    { ref: markdownRef, context: { projectId: "project-a" } },
    { ref: dataRef, context: { projectId: "project-a" } }
  ]);
  assert.equal(stripDeliveredPaths(text, candidates), "Review, again, and.");
});

test("unpinned, invalid, fenced, and foreign artifact references remain text", () => {
  const pinned = "artifact:artifact_0123456789abcdef@2";
  const source = [
    "artifact:artifact_0123456789abcdef",
    "artifact:artifact_0123456789abcdeg@2",
    `\`${pinned}\``,
    "```text",
    pinned,
    "```",
    pinned
  ].join("\n");
  let calls = 0;
  const candidates = scanDeliverables(source, {
    projectId: "project-b",
    resolveArtifact() {
      calls += 1;
      return null;
    }
  });

  assert.deepEqual(candidates, []);
  assert.equal(calls, 1);
  assert.equal(stripDeliveredPaths(source, candidates), source);
});

test("nondefault filesystem delivery is confined to the project workspace", (t) => {
  const root = temporaryDirectory(t);
  const workspaceRoot = path.join(root, "workspace");
  const outsideRoot = path.join(root, "outside");
  fs.mkdirSync(workspaceRoot);
  fs.mkdirSync(outsideRoot);
  const inside = path.join(workspaceRoot, "inside.txt");
  const outside = path.join(outsideRoot, "outside.txt");
  fs.writeFileSync(inside, "inside");
  fs.writeFileSync(outside, "outside");
  const text = `${inside} ${outside}`;

  const scoped = scanDeliverables(text, {
    projectId: "project-c",
    workspaceRoot
  });
  assert.deepEqual(scoped.map((item) => item.buffer.toString()), ["inside"]);

  const missingScope = scanDeliverables(text, { projectId: "project-c" });
  assert.deepEqual(missingScope, []);

  const legacyDefault = scanDeliverables(text, { projectId: "default" });
  assert.deepEqual(
    legacyDefault.map((item) => item.buffer.toString()),
    ["inside", "outside"]
  );
});

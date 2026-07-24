import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DraftStore } from "../src/draft-store.js";
import { ToolRegistry, registerCoreTools } from "../src/tool-registry.js";

function fixture(t, projects) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-project-draft-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const drafts = new DraftStore({ dir: path.join(root, "drafts") });
  const registry = new ToolRegistry();
  registerCoreTools(registry, { drafts, projects });
  return { drafts, save: registry.get("save_draft").handler };
}

test("save_draft never creates an artifact before project attachment succeeds", async (t) => {
  const { drafts, save } = fixture(t, {
    attachResource() {
      throw new Error("project artifact capacity reached");
    }
  });

  await assert.rejects(
    save(
      { title: "Alpha", body: "private draft" },
      { __projectId: "alpha" }
    ),
    /capacity reached/i
  );
  assert.deepEqual(drafts.list({ status: null, projectId: "alpha" }), []);
});

test("save_draft detaches its reservation if draft persistence rejects", async (t) => {
  const attached = [];
  const detached = [];
  const { drafts, save } = fixture(t, {
    attachResource(projectId, field, id) {
      attached.push({ projectId, field, id });
    },
    detachResource(projectId, field, id) {
      detached.push({ projectId, field, id });
    }
  });

  drafts.snapshot = () => {
    throw new Error("draft snapshot failed");
  };
  await assert.rejects(
    save(
      { title: "Alpha", body: "private draft" },
      { __projectId: "alpha" }
    ),
    /snapshot failed/i
  );
  assert.equal(attached.length, 1);
  assert.deepEqual(detached, attached);
  assert.deepEqual(drafts.list({ status: null, projectId: "alpha" }), []);
});

test("save_draft persists the exact project-owned artifact id", async (t) => {
  const attached = [];
  const { drafts, save } = fixture(t, {
    attachResource(projectId, field, id) {
      attached.push({ projectId, field, id });
    },
    detachResource() {
      assert.fail("successful draft must remain attached");
    }
  });

  const result = await save(
    { title: "Alpha", body: "private draft", kind: "doc" },
    { __projectId: "alpha" }
  );
  assert.equal(attached.length, 1);
  assert.equal(attached[0].id, result.draftId);
  assert.equal(
    drafts.get(result.draftId, { projectId: "alpha" }).body,
    "private draft"
  );
  assert.equal(drafts.get(result.draftId, { projectId: "beta" }), null);
});

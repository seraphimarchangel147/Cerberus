// test/outreach-digest.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { OutreachStore } from "../src/outreach-store.js";
import { normalizeOutreachConfig } from "../src/outreach-config.js";
import { composeDigest } from "../src/outreach-digest.js";

function store() {
  return new OutreachStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "out-dig-")) });
}

test("digest rolls up unseen non-decision items by type", () => {
  const s = store();
  s.append({ type: "draft", title: "d1" });
  s.append({ type: "draft", title: "d2" });
  s.append({ type: "suggestion", title: "s1" });
  s.append({ type: "pending-action", title: "p1", needsDecision: true }); // excluded (a decision)
  const cfg = normalizeOutreachConfig({}, {});
  const digest = composeDigest(s, cfg, { now: new Date("2026-06-16T12:00:00") });
  assert.equal(digest.type, "digest");
  assert.match(digest.title, /2 drafts/);
  assert.match(digest.title, /1 suggestion/);
  assert.equal(digest.summary.includes("pending-action"), false);
});

test("digest is suppressed during quiet hours", () => {
  const s = store();
  s.append({ type: "draft", title: "d1" });
  const cfg = normalizeOutreachConfig({}, {});
  const digest = composeDigest(s, cfg, { now: new Date("2026-06-16T23:30:00") });
  assert.equal(digest, null);
});

test("digest returns null when nothing is pending", () => {
  const s = store();
  const cfg = normalizeOutreachConfig({}, {});
  assert.equal(composeDigest(s, cfg, { now: new Date("2026-06-16T12:00:00") }), null);
});

test("unseen skill items roll into the digest", () => {
  const s = store();
  s.append({ type: "skill", sourceRef: { kind: "skill-candidate", id: "sug_1" }, title: "morning-triage" });
  const cfg = normalizeOutreachConfig({}, {});
  const digest = composeDigest(s, cfg, { now: new Date("2026-06-16T12:00:00") });
  assert.ok(digest, "skill items must produce a digest");
  assert.match(digest.title, /1 skill/);
  assert.match(digest.summary, /morning-triage/);
});

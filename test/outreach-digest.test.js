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

test("seen skill items older than 48h reappear under a still-waiting header", () => {
  const s = store();
  const item = s.append({ type: "skill", sourceRef: { kind: "skill-candidate", id: "sug_old" }, title: "morning-triage" });
  s.markSeen([item.id]);
  s.get(item.id).createdAt = "2026-06-13T12:00:00.000Z"; // 3 days before `now`
  const cfg = normalizeOutreachConfig({}, {});
  const digest = composeDigest(s, cfg, { now: new Date("2026-06-16T12:00:00") });
  assert.ok(digest, "stale skill items must produce a digest");
  assert.match(digest.title, /still-waiting skill/);
  assert.match(digest.summary, /Still waiting:/);
  assert.match(digest.summary, /morning-triage/);
  assert.ok(s.get(item.id).lastNudgedAt, "item must be stamped so it is not re-pinged every cadence");
});

test("still-waiting re-ping happens at most once per 24h", () => {
  const s = store();
  const item = s.append({ type: "skill", sourceRef: { kind: "skill-candidate", id: "sug_np" }, title: "weekly-report" });
  s.markSeen([item.id]);
  s.get(item.id).createdAt = "2026-06-10T12:00:00.000Z";
  const cfg = normalizeOutreachConfig({}, {});
  const first = composeDigest(s, cfg, { now: new Date("2026-06-16T12:00:00") });
  assert.ok(first);
  const oneHourLater = composeDigest(s, cfg, { now: new Date("2026-06-16T13:00:00") });
  assert.equal(oneHourLater, null, "must not re-ping within 24h");
  const nextDay = composeDigest(s, cfg, { now: new Date("2026-06-17T13:00:00") });
  assert.ok(nextDay, "after 24h the item is eligible again");
  assert.match(nextDay.title, /still-waiting skill/);
});

test("seen skill items younger than 48h do not trigger a digest", () => {
  const s = store();
  const item = s.append({ type: "skill", sourceRef: { kind: "skill-candidate", id: "sug_new" }, title: "fresh-skill" });
  s.markSeen([item.id]);
  s.get(item.id).createdAt = new Date(new Date("2026-06-16T12:00:00").getTime() - 24 * 3600 * 1000).toISOString();
  const cfg = normalizeOutreachConfig({}, {});
  assert.equal(composeDigest(s, cfg, { now: new Date("2026-06-16T12:00:00") }), null);
});

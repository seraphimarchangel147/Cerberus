# Proactive Outreach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Durably deliver the brain's proactive output (suggestions, drafts, stalled tasks, decisions) to the user as a digest + live-decision feed the Mac app can consume without ever losing an item.

**Architecture:** A server-side **Outreach engine** on the Distiller sits downstream of existing detection. An `OutreachMapper` subscribes to events the runtime already emits and writes each into a durable, cursor-indexed `OutreachStore`. A `DigestComposer` (cron) rolls non-decision items up on a cadence; a stalled-task surfacing step turns sweep-flagged tasks into decisions. HTTP endpoints expose a cursor-backed feed, a digest, and act/reply. The Mac app becomes a durable consumer pointed at the Distiller, rendering notifications + overlay nudges with inline buttons and chat reply. **No detection code changes.**

**Tech Stack:** Node.js (ESM, `node:test`), the repo's file-backed store pattern (`file-utils.js`, `utils.js`), an `EventEmitter` runtime bus, and a macOS SwiftUI app (`UNUserNotificationCenter`, URLSession SSE).

**Spec:** `docs/superpowers/specs/2026-06-16-proactive-outreach-design.md`

---

## File Structure

**Server (create):**
- `src/outreach-config.js` — load/normalize `~/.openagi/outreach.json` + env overrides.
- `src/outreach-store.js` — durable cursor-indexed log of outreach items.
- `src/outreach-mapper.js` — subscribes to runtime events → outreach items; classifies live vs digest.
- `src/outreach-digest.js` — roll up unseen non-decision items into a digest, quiet-hours aware.
- `test/outreach-config.test.js`, `test/outreach-store.test.js`, `test/outreach-mapper.test.js`, `test/outreach-digest.test.js`, `test/outreach-endpoints.test.js`, `test/outreach-stalled.test.js`

**Server (modify):**
- `src/abi-runtime.js` — construct store+mapper; add `outreach-digest` cron job + handler; add `runOutreachDigest`; surface stalled tasks after `task-sweep`.
- `src/hosted-interface.js` — `events.on("outreach", …)` broadcast; `GET /outreach/feed`, `GET /outreach/digest`, `POST /outreach/:id/act`, `POST /outreach/:id/reply`.

**Mac app (modify, `mac/Sources/OpenAGI/`):**
- `Outreach/OutreachConsumer.swift` (create) — remote pointer, cursor, backfill + SSE, act/reply calls.
- `Outreach/OutreachModels.swift` (create) — `OutreachItem`, decode.
- `AppState.swift` — own the consumer, expose items, quiet-hours.
- `Overlay/OverlayState.swift`, `Overlay/OverlayView.swift` — render items + buttons + targeted chat.
- `AppDelegate.swift` — register notification categories/actions; start consumer.
- `TrayController.swift` — badge count.
- `Settings`/`AppState` — remote main URL+token field.

---

## PHASE 1 — Server: config + durable store

### Task 1: Outreach config loader

**Files:**
- Create: `src/outreach-config.js`
- Test: `test/outreach-config.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// test/outreach-config.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOutreachConfig, OUTREACH_DEFAULTS } from "../src/outreach-config.js";

test("defaults are returned when config is empty", () => {
  const c = normalizeOutreachConfig({}, {});
  assert.equal(c.enabled, true);
  assert.equal(c.destination, "mac");
  assert.equal(c.cadenceHours, 3);
  assert.deepEqual(c.quietHours, { start: "22:00", end: "08:00" });
  assert.equal(c.stalledDays, 3);
  assert.ok(c.liveTypes.includes("stalled-task"));
  assert.ok(c.digestTypes.includes("draft"));
});

test("file values override defaults; env overrides file", () => {
  const c = normalizeOutreachConfig(
    { cadenceHours: 6, stalledDays: 7 },
    { OPENAGI_OUTREACH_CADENCE_HOURS: "2" }
  );
  assert.equal(c.cadenceHours, 2);   // env wins
  assert.equal(c.stalledDays, 7);    // file wins over default
});

test("quietHours window check handles overnight wrap", () => {
  const c = normalizeOutreachConfig({}, {});
  assert.equal(c.inQuietHours(new Date("2026-06-16T23:30:00")), true);  // 23:30 is quiet
  assert.equal(c.inQuietHours(new Date("2026-06-16T07:00:00")), true);  // 07:00 is quiet
  assert.equal(c.inQuietHours(new Date("2026-06-16T12:00:00")), false); // noon is awake
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/outreach-config.test.js`
Expected: FAIL — `Cannot find module '../src/outreach-config.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/outreach-config.js
import path from "node:path";
import { readJsonFile } from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";

export const OUTREACH_DEFAULTS = {
  enabled: true,
  destination: "mac",
  cadenceHours: 3,
  quietHours: { start: "22:00", end: "08:00" },
  stalledDays: 3,
  liveTypes: ["stalled-task", "pending-action", "clarification"],
  digestTypes: ["draft", "suggestion"]
};

function minutes(hhmm) {
  const [h, m] = String(hhmm).split(":").map((n) => parseInt(n, 10));
  return (h % 24) * 60 + (m || 0);
}

// File overrides defaults; env overrides file. Returns a frozen config plus
// an inQuietHours(date) helper that correctly handles an overnight window.
export function normalizeOutreachConfig(fileCfg = {}, env = process.env) {
  const merged = { ...OUTREACH_DEFAULTS, ...fileCfg };
  merged.quietHours = { ...OUTREACH_DEFAULTS.quietHours, ...(fileCfg.quietHours ?? {}) };
  if (env.OPENAGI_OUTREACH_CADENCE_HOURS) merged.cadenceHours = Number(env.OPENAGI_OUTREACH_CADENCE_HOURS);
  if (env.OPENAGI_OUTREACH_STALLED_DAYS) merged.stalledDays = Number(env.OPENAGI_OUTREACH_STALLED_DAYS);
  if (env.OPENAGI_OUTREACH_DISABLED === "1") merged.enabled = false;

  merged.inQuietHours = (date = new Date()) => {
    const now = date.getHours() * 60 + date.getMinutes();
    const start = minutes(merged.quietHours.start);
    const end = minutes(merged.quietHours.end);
    return start <= end ? (now >= start && now < end) : (now >= start || now < end);
  };
  return merged;
}

export function loadOutreachConfig(dataDir = resolveDataDir(), env = process.env) {
  const file = readJsonFile(path.join(dataDir, "outreach.json"), {});
  return normalizeOutreachConfig(file, env);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/outreach-config.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/outreach-config.js test/outreach-config.test.js
git commit -m "feat(outreach): config loader with defaults, env override, quiet-hours check"
```

---

### Task 2: OutreachStore (durable cursor-indexed log)

**Files:**
- Create: `src/outreach-store.js`
- Test: `test/outreach-store.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// test/outreach-store.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { OutreachStore } from "../src/outreach-store.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "outreach-"));
}

test("append assigns increasing seq and persists across reload", () => {
  const dir = tmpDir();
  const s = new OutreachStore({ dir });
  const a = s.append({ type: "draft", title: "A", needsDecision: false, actions: ["approve"] });
  const b = s.append({ type: "suggestion", title: "B", needsDecision: false, actions: ["accept"] });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.ok(a.id && a.createdAt);

  const reloaded = new OutreachStore({ dir });
  assert.equal(reloaded.list().length, 2);
  assert.equal(reloaded.nextSeq, 3); // continues, never reuses a seq
});

test("since(cursor) returns only items with a greater seq", () => {
  const dir = tmpDir();
  const s = new OutreachStore({ dir });
  s.append({ type: "draft", title: "A" });
  const b = s.append({ type: "draft", title: "B" });
  s.append({ type: "draft", title: "C" });
  const got = s.since(b.seq);
  assert.deepEqual(got.map((i) => i.title), ["C"]);
});

test("resolve is idempotent and records the decision", () => {
  const dir = tmpDir();
  const s = new OutreachStore({ dir });
  const a = s.append({ type: "stalled-task", title: "X", needsDecision: true, actions: ["close", "keep"] });
  const first = s.resolve(a.id, { action: "close", by: "user" });
  assert.equal(first.status, "acted");
  assert.equal(first.decision.action, "close");
  const second = s.resolve(a.id, { action: "keep", by: "user" });
  assert.equal(second.status, "acted");          // unchanged
  assert.equal(second.decision.action, "close");  // first decision wins
});

test("markSeen flips unseen→seen for the given ids", () => {
  const dir = tmpDir();
  const s = new OutreachStore({ dir });
  const a = s.append({ type: "draft", title: "A" });
  s.markSeen([a.id]);
  assert.equal(s.get(a.id).status, "seen");
});

test("list filters by status", () => {
  const dir = tmpDir();
  const s = new OutreachStore({ dir });
  const a = s.append({ type: "draft", title: "A" });
  s.append({ type: "draft", title: "B" });
  s.resolve(a.id, { action: "approve", by: "user" });
  assert.equal(s.list({ status: "acted" }).length, 1);
  assert.equal(s.list({ status: "unseen" }).length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/outreach-store.test.js`
Expected: FAIL — `Cannot find module '../src/outreach-store.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/outreach-store.js
import path from "node:path";
import { ensureDir, writeJsonAtomic, readJsonFile } from "./file-utils.js";
import { createId, nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

// Durable, cursor-indexed log of outreach items. Every item gets a monotonic
// `seq` so a consumer can ask "everything after seq N" and never miss one —
// this is what makes proactive delivery lossless even if no client was
// connected when the underlying event fired.
//
// Item schema:
//   { id, seq, type, sourceRef:{kind,id}, title, summary, needsDecision,
//     actions:[string], status, decision, error, createdAt, resolvedAt }
//   status: "unseen" | "seen" | "acted" | "dismissed" | "error"

export class OutreachStore {
  constructor({ dir, runtime } = {}) {
    this.dir = dir ?? path.join(resolveDataDir(), "outreach");
    this.runtime = runtime ?? null;
    ensureDir(this.dir);
    this.items = new Map();
    this.nextSeq = 1;
    this._load();
  }

  bindRuntime(runtime) { this.runtime = runtime; }

  append({ type, sourceRef = null, title, summary = "", needsDecision = false, actions = [] }) {
    const item = {
      id: createId("out"),
      seq: this.nextSeq++,
      type,
      sourceRef,
      title: String(title ?? "").trim() || "(untitled)",
      summary: String(summary ?? ""),
      needsDecision: Boolean(needsDecision),
      actions: Array.isArray(actions) ? actions : [],
      status: "unseen",
      decision: null,
      error: null,
      createdAt: nowIso(),
      resolvedAt: null
    };
    this.items.set(item.id, item);
    this.snapshot();
    this.runtime?.events?.emit?.("outreach", item);
    return item;
  }

  get(id) { return this.items.get(id) ?? null; }

  since(cursor = 0) {
    const c = Number(cursor) || 0;
    return [...this.items.values()].filter((i) => i.seq > c).sort((a, b) => a.seq - b.seq);
  }

  list({ status } = {}) {
    const all = [...this.items.values()].sort((a, b) => b.seq - a.seq);
    return status ? all.filter((i) => i.status === status) : all;
  }

  markSeen(ids = []) {
    let changed = false;
    for (const id of ids) {
      const i = this.items.get(id);
      if (i && i.status === "unseen") { i.status = "seen"; changed = true; }
    }
    if (changed) this.snapshot();
  }

  // Idempotent: first resolution wins. Re-resolving returns the existing item.
  resolve(id, decision, { status = "acted", error = null } = {}) {
    const i = this.items.get(id);
    if (!i) return null;
    if (i.status === "acted" || i.status === "dismissed") return i;
    i.status = status;
    i.decision = decision ?? null;
    i.error = error;
    i.resolvedAt = nowIso();
    this.snapshot();
    this.runtime?.events?.emit?.("outreach-resolved", i);
    return i;
  }

  snapshot() {
    writeJsonAtomic(path.join(this.dir, "snapshot.json"), {
      version: 1,
      writtenAt: nowIso(),
      nextSeq: this.nextSeq,
      items: [...this.items.values()]
    });
  }

  _load() {
    const snap = readJsonFile(path.join(this.dir, "snapshot.json"), null);
    if (!snap) return;
    for (const i of snap.items ?? []) this.items.set(i.id, i);
    this.nextSeq = snap.nextSeq ?? (this.items.size ? Math.max(...[...this.items.values()].map((i) => i.seq)) + 1 : 1);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/outreach-store.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/outreach-store.js test/outreach-store.test.js
git commit -m "feat(outreach): durable cursor-indexed OutreachStore"
```

---

## PHASE 2 — Server: mapper (events → items)

### Task 3: OutreachMapper

**Files:**
- Create: `src/outreach-mapper.js`
- Test: `test/outreach-mapper.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// test/outreach-mapper.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { OutreachStore } from "../src/outreach-store.js";
import { OutreachMapper } from "../src/outreach-mapper.js";

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-map-"));
  const events = new EventEmitter();
  const store = new OutreachStore({ dir, runtime: { events } });
  const mapper = new OutreachMapper({ store, events });
  mapper.attach();
  return { events, store };
}

test("draft-created maps to a digest item (needsDecision=false)", () => {
  const { events, store } = harness();
  events.emit("draft-created", { id: "draft_1", title: "Reply to Acme", kind: "reply" });
  const items = store.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "draft");
  assert.equal(items[0].needsDecision, false);
  assert.deepEqual(items[0].sourceRef, { kind: "draft", id: "draft_1" });
  assert.ok(items[0].actions.includes("approve"));
});

test("pending-action maps to a live decision (needsDecision=true)", () => {
  const { events, store } = harness();
  events.emit("pending-action", { id: "act_1", summary: "Connect MCP: github" });
  const item = store.list()[0];
  assert.equal(item.type, "pending-action");
  assert.equal(item.needsDecision, true);
  assert.ok(item.actions.includes("do") && item.actions.includes("dismiss"));
});

test("proactive-suggestion maps to a digest suggestion", () => {
  const { events, store } = harness();
  events.emit("proactive-suggestion", { id: "prop_1", title: "Connect GitHub", category: "mcp", rationale: "seen often" });
  const item = store.list()[0];
  assert.equal(item.type, "suggestion");
  assert.equal(item.needsDecision, false);
  assert.equal(item.sourceRef.id, "prop_1");
});

test("unknown events are ignored (no item created)", () => {
  const { events, store } = harness();
  events.emit("miner-result", { source: "task-sweep" });
  assert.equal(store.list().length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/outreach-mapper.test.js`
Expected: FAIL — `Cannot find module '../src/outreach-mapper.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/outreach-mapper.js
// The ONLY bridge between existing detection and the outreach feed. It listens
// to events the runtime already emits and turns each into one outreach item.
// Nothing in the observer / miners / planner / stores changes.

const MAP = {
  "draft-created": (d) => ({
    type: "draft",
    sourceRef: { kind: "draft", id: d.id },
    title: d.title ?? "Draft ready",
    summary: (d.body ?? "").slice(0, 160),
    needsDecision: false,
    actions: ["approve", "edit", "dismiss"]
  }),
  "proactive-suggestion": (d) => ({
    type: "suggestion",
    sourceRef: { kind: "suggestion", id: d.id },
    title: d.title ?? "New suggestion",
    summary: d.rationale ?? "",
    needsDecision: false,
    actions: ["accept", "dismiss"]
  }),
  "pending-action": (d) => ({
    type: "pending-action",
    sourceRef: { kind: "pending-action", id: d.id },
    title: d.summary ?? "Action needs approval",
    summary: d.reason ?? "",
    needsDecision: true,
    actions: ["do", "dismiss"]
  }),
  "clarification-created": (d) => ({
    type: "clarification",
    sourceRef: { kind: "clarification", id: d.id },
    title: d.question ?? "Quick question",
    summary: d.context ?? "",
    needsDecision: true,
    actions: ["yes", "no", "in_progress", "dropped"]
  })
};

export class OutreachMapper {
  constructor({ store, events }) {
    this.store = store;
    this.events = events;
    this._handlers = [];
  }

  attach() {
    for (const [event, build] of Object.entries(MAP)) {
      const handler = (data) => {
        try {
          const spec = build(data ?? {});
          if (spec) this.store.append(spec);
        } catch { /* never let a malformed event break the bus */ }
      };
      this.events.on(event, handler);
      this._handlers.push([event, handler]);
    }
  }

  detach() {
    for (const [event, handler] of this._handlers) this.events.off(event, handler);
    this._handlers = [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/outreach-mapper.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/outreach-mapper.js test/outreach-mapper.test.js
git commit -m "feat(outreach): OutreachMapper — events to durable items (no detection changes)"
```

---

## PHASE 3 — Server: stalled-task surfacing + digest

### Task 4: Surface sweep-flagged stalled tasks

Context: `task-sweep` already flags stale non-auto-sourced tasks. We surface each **flagged** task as a `stalled-task` decision item, deduped so the same task isn't re-surfaced while still open.

**Files:**
- Create: `src/outreach-stalled.js`
- Test: `test/outreach-stalled.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// test/outreach-stalled.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { OutreachStore } from "../src/outreach-store.js";
import { surfaceStalledTasks } from "../src/outreach-stalled.js";

function store() {
  return new OutreachStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "out-stall-")) });
}

test("flagged tasks become stalled-task decision items", () => {
  const s = store();
  const flagged = [{ id: "task_1", title: "Lock the Hyundai" }, { id: "task_2", title: "Reply to Sam" }];
  const created = surfaceStalledTasks(s, flagged);
  assert.equal(created, 2);
  const item = s.list()[0];
  assert.equal(item.type, "stalled-task");
  assert.equal(item.needsDecision, true);
  assert.ok(item.actions.includes("close") && item.actions.includes("keep") && item.actions.includes("snooze"));
});

test("a task already surfaced and still open is not duplicated", () => {
  const s = store();
  surfaceStalledTasks(s, [{ id: "task_1", title: "X" }]);
  const again = surfaceStalledTasks(s, [{ id: "task_1", title: "X" }]);
  assert.equal(again, 0);
  assert.equal(s.list().length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/outreach-stalled.test.js`
Expected: FAIL — `Cannot find module '../src/outreach-stalled.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/outreach-stalled.js
// Turn task-sweep's "flagged stale" tasks into stalled-task decisions, deduped
// against any still-open stalled-task item for the same task id.
export function surfaceStalledTasks(store, flaggedTasks = []) {
  const openTaskIds = new Set(
    store.list()
      .filter((i) => i.type === "stalled-task" && (i.status === "unseen" || i.status === "seen"))
      .map((i) => i.sourceRef?.id)
  );
  let created = 0;
  for (const t of flaggedTasks) {
    if (!t?.id || openTaskIds.has(t.id)) continue;
    store.append({
      type: "stalled-task",
      sourceRef: { kind: "task", id: t.id },
      title: `Stalled: ${t.title ?? t.id}`,
      summary: "No activity recently — close it out, keep it, or snooze?",
      needsDecision: true,
      actions: ["close", "keep", "snooze"]
    });
    created++;
  }
  return created;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/outreach-stalled.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/outreach-stalled.js test/outreach-stalled.test.js
git commit -m "feat(outreach): surface sweep-flagged stalled tasks as decisions (deduped)"
```

---

### Task 5: DigestComposer

**Files:**
- Create: `src/outreach-digest.js`
- Test: `test/outreach-digest.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/outreach-digest.test.js`
Expected: FAIL — `Cannot find module '../src/outreach-digest.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/outreach-digest.js
// Roll unseen, non-decision items into a single digest item, on cadence,
// suppressed during quiet hours. Decisions are delivered live, not here.
function plural(n, word) { return `${n} ${word}${n === 1 ? "" : "s"}`; }

export function composeDigest(store, config, { now = new Date() } = {}) {
  if (config.inQuietHours(now)) return null;
  const pending = store.list({ status: "unseen" })
    .filter((i) => !i.needsDecision && config.digestTypes.includes(i.type));
  if (pending.length === 0) return null;

  const counts = {};
  for (const i of pending) counts[i.type] = (counts[i.type] ?? 0) + 1;
  const parts = Object.entries(counts).map(([type, n]) => plural(n, type));
  const item = store.append({
    type: "digest",
    title: `Your queue: ${parts.join(" · ")}`,
    summary: pending.slice(0, 8).map((i) => `• ${i.title}`).join("\n"),
    needsDecision: false,
    actions: ["review", "dismiss"]
  });
  store.markSeen(pending.map((i) => i.id)); // rolled up — don't re-digest next cycle
  return item;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/outreach-digest.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/outreach-digest.js test/outreach-digest.test.js
git commit -m "feat(outreach): DigestComposer — cadence rollup, quiet-hours suppression"
```

---

## PHASE 4 — Server: wire into runtime

### Task 6: Construct store+mapper; cron job + handler; stalled surfacing

**Files:**
- Modify: `src/abi-runtime.js`

- [ ] **Step 1: Add imports near the other store imports (top of file)**

```javascript
import { OutreachStore } from "./outreach-store.js";
import { OutreachMapper } from "./outreach-mapper.js";
import { loadOutreachConfig } from "./outreach-config.js";
import { surfaceStalledTasks } from "./outreach-stalled.js";
import { composeDigest } from "./outreach-digest.js";
```

- [ ] **Step 2: Construct the store + mapper in the runtime constructor, right after `this.drafts = …` (currently line ~191)**

```javascript
    this.outreachConfig = loadOutreachConfig(options.dataDir);
    this.outreach = options.outreach ?? new OutreachStore({
      dir: options.dataDir ? path.join(options.dataDir, "outreach") : undefined,
      runtime: this
    });
    if (this.outreachConfig.enabled) {
      this.outreachMapper = new OutreachMapper({ store: this.outreach, events: this.events });
      this.outreachMapper.attach();
    }
```

(If `path` isn't already imported at the top of `abi-runtime.js`, add `import path from "node:path";`.)

- [ ] **Step 3: Register the digest cron job — beside the `task-sweep` addJob (currently line ~393)**

```javascript
      this.cron.addJob({
        id: "outreach-digest",
        name: `Outreach digest every ${this.outreachConfig.cadenceHours}h`,
        enabled: this.outreachConfig.enabled,
        task: "outreach-digest",
        intervalMs: this.outreachConfig.cadenceHours * 60 * 60 * 1000
      });
```

- [ ] **Step 4: Add the cron handler — beside the `task-sweep` handler (currently line ~693). Also surface stalled tasks from the sweep result.**

Replace the existing `task-sweep` handler block:

```javascript
      if (job.task === "task-sweep") {
        const result = await this.taskSweep.sweep({ now });
        this.events?.emit?.("miner-result", { source: "task-sweep", at: nowIso(), ...result });
        return result;
      }
```

with:

```javascript
      if (job.task === "task-sweep") {
        const result = await this.taskSweep.sweep({ now });
        if (this.outreachConfig?.enabled && Array.isArray(result.flaggedTasks)) {
          surfaceStalledTasks(this.outreach, result.flaggedTasks);
        }
        this.events?.emit?.("miner-result", { source: "task-sweep", at: nowIso(), ...result });
        return result;
      }
      if (job.task === "outreach-digest") {
        return this.runOutreachDigest({ now });
      }
```

- [ ] **Step 5: Add the `runOutreachDigest` method on the runtime class (next to `runTaskDigest`)**

```javascript
  runOutreachDigest({ now = new Date() } = {}) {
    if (!this.outreachConfig?.enabled) return { skipped: true, reason: "outreach disabled" };
    const item = composeDigest(this.outreach, this.outreachConfig, { now });
    return item ? { ok: true, digestId: item.id, title: item.title } : { ok: true, empty: true };
  }
```

- [ ] **Step 6: Verify `task-sweep` exposes `flaggedTasks`.**

Run: `grep -n "flagged" src/task-sweep.js`
Expected: a `flagged` count exists. If the sweep returns only a count (not the task list), add a `flaggedTasks` array to its return value:
- Open `src/task-sweep.js`, find where it builds the summary `{ deduped, requeued, …, flagged, … }`, and include `flaggedTasks` — the array of `{ id, title }` it flagged. (If it already tracks them internally, expose them; otherwise collect `{id,title}` as it flags.)

- [ ] **Step 7: Run the full server test suite**

Run: `node --test test/outreach-*.test.js test/boot-crash-guards.test.js`
Expected: PASS (all outreach + boot tests)

- [ ] **Step 8: Commit**

```bash
git add src/abi-runtime.js src/task-sweep.js
git commit -m "feat(outreach): wire store+mapper into runtime, digest cron, stalled surfacing"
```

---

## PHASE 5 — Server: endpoints

### Task 7: GET /outreach/feed and /outreach/digest

**Files:**
- Modify: `src/hosted-interface.js`
- Test: `test/outreach-endpoints.test.js`

- [ ] **Step 1: Write the failing test (in-process, against `createHostedInterface`)**

```javascript
// test/outreach-endpoints.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

async function bootApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "out-ep-"));
  process.env.OPENAGI_AUTH_TOKEN = ""; // local, no auth for the test
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0 });
  const { url } = await app.listen();
  return { runtime, app, base: url, dataDir };
}

test("GET /outreach/feed?since=N returns items after the cursor", async () => {
  const { runtime, app, base } = await bootApp();
  runtime.outreach.append({ type: "draft", title: "A" });
  const b = runtime.outreach.append({ type: "draft", title: "B" });
  runtime.outreach.append({ type: "draft", title: "C" });
  const res = await fetch(`${base}/outreach/feed?since=${b.seq}`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(json.items.map((i) => i.title), ["C"]);
  assert.equal(json.cursor, runtime.outreach.nextSeq - 1);
  await app.close?.();
});

test("GET /outreach/digest returns the current rollup or empty", async () => {
  const { runtime, app, base } = await bootApp();
  runtime.outreach.append({ type: "draft", title: "A" });
  const res = await fetch(`${base}/outreach/digest`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.ok("digest" in json);
  await app.close?.();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/outreach-endpoints.test.js`
Expected: FAIL — feed route returns 404 / `items` undefined.

- [ ] **Step 3: Add the broadcast wiring + routes in `src/hosted-interface.js`**

Add beside the other `events.on(...)` lines (after line ~70):

```javascript
  events.on("outreach", (data) => broadcast("outreach", data));
  events.on("outreach-resolved", (data) => broadcast("outreach-resolved", data));
```

Add the GET routes alongside the other `/...` route handlers (e.g. right after the `/pending-actions` GET):

```javascript
      if (method === "GET" && pathname === "/outreach/feed") {
        const since = Number(url.searchParams.get("since") ?? 0);
        const items = runtime.outreach?.since(since) ?? [];
        return sendJson(res, 200, { items, cursor: runtime.outreach?.nextSeq ? runtime.outreach.nextSeq - 1 : since });
      }
      if (method === "GET" && pathname === "/outreach/digest") {
        const digest = runtime.outreachConfig
          ? composeDigest(runtime.outreach, runtime.outreachConfig, { now: new Date() })
          : null;
        return sendJson(res, 200, { digest });
      }
```

Add the import at the top of `hosted-interface.js`:

```javascript
import { composeDigest } from "./outreach-digest.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/outreach-endpoints.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/hosted-interface.js test/outreach-endpoints.test.js
git commit -m "feat(outreach): GET /outreach/feed + /outreach/digest + SSE broadcast"
```

---

### Task 8: POST /outreach/:id/act (delegation + idempotency)

**Files:**
- Modify: `src/hosted-interface.js`
- Test: append to `test/outreach-endpoints.test.js`

- [ ] **Step 1: Write the failing test (append to the endpoints test file)**

```javascript
test("POST /outreach/:id/act approves a draft via delegation and is idempotent", async () => {
  const { runtime, app, base } = await bootApp();
  const draft = runtime.drafts.add({ kind: "reply", title: "Reply", body: "hello" });
  // simulate the mapper having created an outreach item for it
  const item = runtime.outreach.append({
    type: "draft", sourceRef: { kind: "draft", id: draft.id },
    title: "Reply", needsDecision: false, actions: ["approve", "dismiss"]
  });
  const res = await fetch(`${base}/outreach/${item.id}/act`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "approve" })
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(runtime.drafts.get(draft.id).status, "approved");
  assert.equal(runtime.outreach.get(item.id).status, "acted");

  // idempotent: second act returns the already-acted item, no error
  const res2 = await fetch(`${base}/outreach/${item.id}/act`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "dismiss" })
  });
  assert.equal(res2.status, 200);
  assert.equal(runtime.outreach.get(item.id).decision.action, "approve"); // first wins
  await app.close?.();
});

test("POST /outreach/:id/act on unknown id returns 404", async () => {
  const { app, base } = await bootApp();
  const res = await fetch(`${base}/outreach/nope/act`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "approve" })
  });
  assert.equal(res.status, 404);
  await app.close?.();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/outreach-endpoints.test.js`
Expected: FAIL — act route 404 / draft not approved.

- [ ] **Step 3: Add the `/act` route in `src/hosted-interface.js` (after the digest route)**

```javascript
      if (method === "POST" && pathname.startsWith("/outreach/") && pathname.endsWith("/act")) {
        const id = decodeURIComponent(pathname.slice("/outreach/".length, -"/act".length));
        const item = runtime.outreach?.get(id);
        if (!item) return sendJson(res, 404, { error: "unknown outreach item" });
        if (item.status === "acted" || item.status === "dismissed") {
          return sendJson(res, 200, { item }); // idempotent no-op
        }
        const body = await readJson(req).catch(() => ({}));
        const action = String(body.action ?? "");
        try {
          await applyOutreachAction(runtime, item, action, body.note);
          const status = action === "dismiss" ? "dismissed" : "acted";
          const updated = runtime.outreach.resolve(id, { action, by: "user", note: body.note ?? null }, { status });
          return sendJson(res, 200, { item: updated });
        } catch (error) {
          const updated = runtime.outreach.resolve(id, { action, by: "user" }, { status: "error", error: error.message });
          return sendJson(res, 400, { item: updated, error: error.message });
        }
      }
```

Add this delegation helper near the top of the module (module scope, after imports):

```javascript
// Map an outreach action to the real action on the underlying source. Throws
// on a failed delegation so the route can mark the item status:"error".
async function applyOutreachAction(runtime, item, action, note) {
  if (action === "dismiss") return;
  const ref = item.sourceRef ?? {};
  switch (ref.kind) {
    case "draft":
      if (action === "approve") { if (!runtime.drafts?.approve(ref.id)) throw new Error("draft not approvable"); return; }
      if (action === "edit") return; // edit happens via the existing /drafts PATCH; act just records intent
      throw new Error(`unsupported draft action: ${action}`);
    case "task":
      if (action === "close") { if (!runtime.tasks?.cancel?.(ref.id)) throw new Error("task not cancellable"); return; }
      if (action === "keep" || action === "snooze") return; // keep = leave as-is; snooze handled by sweep next cycle
      throw new Error(`unsupported task action: ${action}`);
    case "pending-action":
      if (action === "do") {
        const a = runtime.pendingActions?.get(ref.id);
        if (!a) throw new Error("pending action gone");
        const r = await runtime.tools.invoke(a.toolName, a.args, { ...a.context, __confirmed: true });
        runtime.pendingActions.decide(ref.id, { decision: "approve", decidedBy: "user", result: r.ok ? r.result : null, error: r.ok ? null : r.error });
        if (!r.ok) throw new Error(r.error ?? "tool failed");
        return;
      }
      throw new Error(`unsupported pending-action action: ${action}`);
    case "suggestion":
      if (action === "accept") return; // delegated to existing /proactive/suggestions accept flow in a follow-up; record intent now
      throw new Error(`unsupported suggestion action: ${action}`);
    case "clarification":
      return; // answer flows through existing /tasks/clarifications/:id/answer; act records the choice
    default:
      return; // digest "review"/"dismiss" need no delegation
  }
}
```

(Note: verify the exact method names with `grep -n "cancel\|complete" src/task-store.js` and adjust `runtime.tasks.cancel` to the real cancel method; if it is named differently, use that name consistently.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/outreach-endpoints.test.js`
Expected: PASS (all endpoint tests)

- [ ] **Step 5: Commit**

```bash
git add src/hosted-interface.js test/outreach-endpoints.test.js
git commit -m "feat(outreach): POST /outreach/:id/act with delegation + idempotency"
```

---

### Task 9: POST /outreach/:id/reply

**Files:**
- Modify: `src/hosted-interface.js`
- Test: append to `test/outreach-endpoints.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
test("POST /outreach/:id/reply forwards the text to the agent with item context", async () => {
  const { runtime, app, base } = await bootApp();
  const item = runtime.outreach.append({ type: "stalled-task", sourceRef: { kind: "task", id: "task_9" }, title: "Stalled: X", needsDecision: true, actions: ["close", "keep"] });
  // stub the agent host so we don't make a model call in the test
  runtime.__lastForward = null;
  const fakeChannels = { handleLocalMessage: async (m) => { runtime.__lastForward = m; return { reply: "ok" }; } };
  app.__setChannels?.(fakeChannels);
  const res = await fetch(`${base}/outreach/${item.id}/reply`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "close it and remind me Friday" })
  });
  assert.equal(res.status, 200);
  assert.match(runtime.__lastForward.text, /close it and remind me Friday/);
  assert.match(runtime.__lastForward.text, /Stalled: X/); // item context injected
  await app.close?.();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/outreach-endpoints.test.js`
Expected: FAIL — reply route 404 and/or `__setChannels` undefined.

- [ ] **Step 3: Implement**

In `createHostedInterface`, expose a test seam if one does not already exist — locate where `channels` is referenced and add (once):

```javascript
  app.__setChannels = (c) => { channels = c; };
```

(If `channels` is a `const`, change it to `let` at its declaration so the seam can reassign it.)

Add the route after `/act`:

```javascript
      if (method === "POST" && pathname.startsWith("/outreach/") && pathname.endsWith("/reply")) {
        const id = decodeURIComponent(pathname.slice("/outreach/".length, -"/reply".length));
        const item = runtime.outreach?.get(id);
        if (!item) return sendJson(res, 404, { error: "unknown outreach item" });
        if (!channels) return sendJson(res, 503, { error: "agent-host-disabled" });
        const body = await readJson(req);
        const forward = `Re: "${item.title}" (${item.type}, actions: ${item.actions.join("/")}).\nUser says: ${body.text ?? ""}\nInterpret intent and take the appropriate action.`;
        const turn = await channels.handleLocalMessage({ text: forward, from: `outreach:${id}` });
        return sendJson(res, 200, { reply: turn.reply ?? null });
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/outreach-endpoints.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/hosted-interface.js test/outreach-endpoints.test.js
git commit -m "feat(outreach): POST /outreach/:id/reply — freeform reply with item context"
```

---

### Task 10: Full server suite green

- [ ] **Step 1: Run the whole suite**

Run: `node --test`
Expected: all outreach tests pass; the 2 pre-existing unrelated failures (`abi-runtime` autopilot, `ephemeral-turn`) remain as before — confirm no NEW failures.

- [ ] **Step 2: Commit (only if any fixups were needed)**

```bash
git add -A && git commit -m "test(outreach): server suite green"
```

---

## PHASE 6 — Mac app: durable consumer + surfaces

> Swift UI is verified manually (checklist in Task 15). The cursor/consumer logic is the testable core; keep it in a plain model so it can be reasoned about.

### Task 11: Remote-main pointer + models

**Files:**
- Create: `mac/Sources/OpenAGI/Outreach/OutreachModels.swift`
- Modify: `mac/Sources/OpenAGI/AppState.swift`

- [ ] **Step 1: Add the model**

```swift
// mac/Sources/OpenAGI/Outreach/OutreachModels.swift
import Foundation

struct OutreachItem: Identifiable, Decodable, Equatable {
  let id: String
  let seq: Int
  let type: String
  let title: String
  let summary: String
  let needsDecision: Bool
  let actions: [String]
  let status: String
}

struct OutreachFeedResponse: Decodable {
  let items: [OutreachItem]
  let cursor: Int
}
```

- [ ] **Step 2: Add a remote-main setting on AppState (URL + token), persisted in UserDefaults**

```swift
// in AppState.swift
@Published var outreachRemoteURL: String = UserDefaults.standard.string(forKey: "outreachRemoteURL") ?? ""
@Published var outreachToken: String = UserDefaults.standard.string(forKey: "outreachToken") ?? ""

func setOutreachMain(url: String, token: String) {
  outreachRemoteURL = url; outreachToken = token
  UserDefaults.standard.set(url, forKey: "outreachRemoteURL")
  UserDefaults.standard.set(token, forKey: "outreachToken")
  OutreachConsumer.shared.reconfigure(url: url, token: token)
}
```

- [ ] **Step 3: Build the app**

Run: `cd mac && swift build`
Expected: Build complete (OutreachConsumer referenced next task — comment out the `reconfigure` call until Task 12 compiles, or implement Task 12 before building).

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/OpenAGI/Outreach/OutreachModels.swift mac/Sources/OpenAGI/AppState.swift
git commit -m "feat(mac/outreach): outreach models + remote-main pointer setting"
```

---

### Task 12: OutreachConsumer (cursor + backfill + SSE)

**Files:**
- Create: `mac/Sources/OpenAGI/Outreach/OutreachConsumer.swift`

- [ ] **Step 1: Implement the consumer**

```swift
// mac/Sources/OpenAGI/Outreach/OutreachConsumer.swift
import Foundation

@MainActor
final class OutreachConsumer: ObservableObject {
  static let shared = OutreachConsumer()

  @Published private(set) var items: [OutreachItem] = []
  private var baseURL: URL?
  private var token: String = ""
  private var cursor: Int { UserDefaults.standard.integer(forKey: "outreachCursor") }
  private func setCursor(_ v: Int) { UserDefaults.standard.set(v, forKey: "outreachCursor") }
  private var sseTask: URLSessionDataTask?

  func reconfigure(url: String, token: String) {
    self.baseURL = URL(string: url)
    self.token = token
    Task { await backfill() }
    startSSE()
  }

  private func authed(_ req: inout URLRequest) {
    if !token.isEmpty { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
  }

  // Pull everything we missed since our last cursor — lossless on reconnect.
  func backfill() async {
    guard let base = baseURL else { return }
    var req = URLRequest(url: base.appendingPathComponent("outreach/feed")
      .appending(queryItems: [URLQueryItem(name: "since", value: String(cursor))]))
    authed(&req)
    do {
      let (data, _) = try await URLSession.shared.data(for: req)
      let feed = try JSONDecoder().decode(OutreachFeedResponse.self, from: data)
      ingest(feed.items)
      if feed.cursor > cursor { setCursor(feed.cursor) }
    } catch { /* offline: keep cursor, retry on next reconfigure/SSE reconnect */ }
  }

  private func ingest(_ incoming: [OutreachItem]) {
    for item in incoming where !items.contains(where: { $0.id == item.id }) {
      items.insert(item, at: 0)
      NotificationPresenter.shared.present(item)   // Task 13
    }
  }

  func act(_ id: String, action: String, note: String? = nil) async {
    await post("outreach/\(id)/act", body: ["action": action, "note": note as Any])
    items.removeAll { $0.id == id }
  }
  func reply(_ id: String, text: String) async {
    await post("outreach/\(id)/reply", body: ["text": text])
    items.removeAll { $0.id == id }
  }

  private func post(_ pathPart: String, body: [String: Any]) async {
    guard let base = baseURL else { return }
    var req = URLRequest(url: base.appendingPathComponent(pathPart))
    req.httpMethod = "POST"; req.setValue("application/json", forHTTPHeaderField: "content-type")
    authed(&req)
    req.httpBody = try? JSONSerialization.data(withJSONObject: body.compactMapValues { $0 is NSNull ? nil : $0 })
    _ = try? await URLSession.shared.data(for: req)
  }

  private func startSSE() {
    guard let base = baseURL else { return }
    sseTask?.cancel()
    var req = URLRequest(url: base.appendingPathComponent("events"))
    authed(&req)
    // Reuse the app's existing SSE delegate plumbing; on any "outreach" event,
    // call backfill() to fold in the new item (keeps cursor authoritative).
    sseTask = OutreachSSE.shared.start(req) { [weak self] in Task { await self?.backfill() } }
  }
}
```

- [ ] **Step 2: Add a tiny SSE helper (or reuse `SSEDelegate`) — `OutreachSSE`**

```swift
// append to OutreachConsumer.swift
final class OutreachSSE: NSObject, URLSessionDataDelegate {
  static let shared = OutreachSSE()
  private var onOutreach: (() -> Void)?
  private var buffer = ""
  func start(_ req: URLRequest, onOutreach: @escaping () -> Void) -> URLSessionDataTask {
    self.onOutreach = onOutreach
    let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    let task = session.dataTask(with: req); task.resume(); return task
  }
  func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    buffer += String(data: data, encoding: .utf8) ?? ""
    while let nl = buffer.range(of: "\n\n") {
      let block = String(buffer[..<nl.lowerBound]); buffer.removeSubrange(buffer.startIndex..<nl.upperBound)
      if block.contains("event: outreach") { onOutreach?() }
    }
  }
  func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError e: Error?) {
    // reconnect after 5s
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { OutreachConsumer.shared.backfill() } // backfill re-pulls + restarts
  }
}
```

- [ ] **Step 3: Build**

Run: `cd mac && swift build`
Expected: Build complete (NotificationPresenter referenced — implement Task 13 next, or stub `present` to no-op to build incrementally).

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/OpenAGI/Outreach/OutreachConsumer.swift
git commit -m "feat(mac/outreach): durable consumer — cursor backfill + SSE refresh + act/reply"
```

---

### Task 13: Notifications with inline action buttons

**Files:**
- Create: `mac/Sources/OpenAGI/Outreach/NotificationPresenter.swift`
- Modify: `mac/Sources/OpenAGI/AppDelegate.swift`

- [ ] **Step 1: Register categories/actions in AppDelegate `applicationDidFinishLaunching`**

```swift
// in AppDelegate.swift, after existing notification setup
NotificationPresenter.shared.registerCategories()
UNUserNotificationCenter.current().delegate = NotificationPresenter.shared
```

- [ ] **Step 2: Implement the presenter**

```swift
// mac/Sources/OpenAGI/Outreach/NotificationPresenter.swift
import Foundation
import UserNotifications

@MainActor
final class NotificationPresenter: NSObject, UNUserNotificationCenterDelegate {
  static let shared = NotificationPresenter()

  func registerCategories() {
    func cat(_ id: String, _ actions: [(String, String)]) -> UNNotificationCategory {
      UNNotificationCategory(identifier: id,
        actions: actions.map { UNNotificationAction(identifier: $0.0, title: $0.1, options: []) },
        intentIdentifiers: [], options: [])
    }
    UNUserNotificationCenter.current().setNotificationCategories([
      cat("stalled-task", [("close", "Close it"), ("keep", "Keep"), ("snooze", "Snooze")]),
      cat("pending-action", [("do", "Do it"), ("dismiss", "Not now")]),
      cat("clarification", [("yes", "Yes"), ("no", "No"), ("in_progress", "In progress")]),
      cat("draft", [("approve", "Approve"), ("dismiss", "Dismiss")]),
      cat("digest", [("review", "Review")])
    ])
  }

  // Quiet-hours-aware. Live decisions notify immediately; digests notify; other
  // non-decision items just populate the overlay (no banner spam).
  func present(_ item: OutreachItem) {
    if AppState.shared.inQuietHours() && item.needsDecision { return } // hold until morning digest
    guard item.needsDecision || item.type == "digest" else { return }   // drafts/suggestions: overlay only
    let content = UNMutableNotificationContent()
    content.title = item.title
    content.body = item.summary
    content.categoryIdentifier = item.type
    content.userInfo = ["outreachId": item.id]
    UNUserNotificationCenter.current().add(
      UNNotificationRequest(identifier: item.id, content: content, trigger: nil))
  }

  // Action button tapped on a notification → call the server.
  func userNotificationCenter(_ c: UNUserNotificationCenter,
                              didReceive resp: UNNotificationResponse) async {
    guard let id = resp.notification.request.content.userInfo["outreachId"] as? String else { return }
    let action = resp.actionIdentifier
    if action == UNNotificationDefaultActionIdentifier || action == "review" {
      OverlayController.shared.show()       // open the overlay list
      return
    }
    await OutreachConsumer.shared.act(id, action: action)
  }

  func userNotificationCenter(_ c: UNUserNotificationCenter,
    willPresent n: UNNotification) async -> UNNotificationPresentationOptions { [.banner, .sound] }
}
```

- [ ] **Step 3: Add `inQuietHours()` to AppState (mirrors server config; default 22:00–08:00, overridable later)**

```swift
// in AppState.swift
func inQuietHours(_ date: Date = Date()) -> Bool {
  let h = Calendar.current.component(.hour, from: date)
  return h >= 22 || h < 8
}
```

- [ ] **Step 4: Build**

Run: `cd mac && swift build`
Expected: Build complete.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/OpenAGI/Outreach/NotificationPresenter.swift mac/Sources/OpenAGI/AppDelegate.swift mac/Sources/OpenAGI/AppState.swift
git commit -m "feat(mac/outreach): notifications with inline action buttons, quiet-hours aware"
```

---

### Task 14: Overlay list + buttons + targeted chat; tray badge

**Files:**
- Modify: `mac/Sources/OpenAGI/Overlay/OverlayState.swift`, `Overlay/OverlayView.swift`, `TrayController.swift`

- [ ] **Step 1: Surface consumer items in the overlay**

```swift
// OverlayView.swift — add a section listing OutreachConsumer.shared.items
@ObservedObject private var outreach = OutreachConsumer.shared
// ... inside the expanded panel body:
ForEach(outreach.items) { item in
  VStack(alignment: .leading, spacing: 4) {
    Text(item.title).font(.system(size: 12, weight: .semibold))
    if !item.summary.isEmpty { Text(item.summary).font(.system(size: 11)).foregroundColor(.secondary) }
    HStack {
      ForEach(item.actions, id: \.self) { a in
        Button(a.capitalized) { Task { await outreach.act(item.id, action: a) } }
          .buttonStyle(.borderless)
      }
    }
    // Targeted chat reply: reuse the existing Quick Ask field, scoped to this item.
    HStack {
      TextField("Reply…", text: replyBinding(for: item.id))
      Button("Send") { Task { await outreach.reply(item.id, text: replyText[item.id] ?? "") } }
    }
  }
  Divider()
}
```

Add this state + binding helper to the view struct:

```swift
@State private var replyText: [String: String] = [:]

private func replyBinding(for id: String) -> Binding<String> {
  Binding(get: { replyText[id] ?? "" }, set: { replyText[id] = $0 })
}
```

- [ ] **Step 2: Tray badge = count of pending items**

```swift
// TrayController.swift — where the status line is built
let pending = OutreachConsumer.shared.items.count
// append " (\(pending))" to the tray title when pending > 0, or set statusItem.button badge
```

- [ ] **Step 3: Build**

Run: `cd mac && swift build`
Expected: Build complete.

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/OpenAGI/Overlay/OverlayState.swift mac/Sources/OpenAGI/Overlay/OverlayView.swift mac/Sources/OpenAGI/TrayController.swift
git commit -m "feat(mac/outreach): overlay list with inline buttons + targeted chat, tray badge"
```

---

### Task 15: Wire startup + manual verification

**Files:**
- Modify: `mac/Sources/OpenAGI/AppDelegate.swift`

- [ ] **Step 1: Start the consumer on launch if a remote main is configured**

```swift
// in applicationDidFinishLaunching, after AppState setup
if !AppState.shared.outreachRemoteURL.isEmpty {
  OutreachConsumer.shared.reconfigure(url: AppState.shared.outreachRemoteURL, token: AppState.shared.outreachToken)
}
```

- [ ] **Step 2: Point it at the Distiller (one-time, from the running app or via defaults)**

```bash
defaults write app.openagi.daemon outreachRemoteURL "http://<your-main-host>:43210"
defaults write app.openagi.daemon outreachToken "<the main's OPENAGI_AUTH_TOKEN>"
```

`<your-main-host>` is wherever your main runs — e.g. `distiller.local`, a LAN IP, or a Tailscale MagicDNS name. The bundle id `app.openagi.daemon` is from `mac/Resources/Info.plist` `CFBundleIdentifier` (verify if it changes).

- [ ] **Step 3: Build + run**

Run: `cd mac && swift build && ./scripts/build-mac-app.sh` (or run the built app)

- [ ] **Step 4: Manual verification checklist**

- [ ] On launch with the app closed for a while, the overlay backfills the existing pending items (the 67 drafts show as a digest / list — not lost).
- [ ] A live decision (stalled-task / pending-action) fires a notification with the right buttons.
- [ ] Tapping **Close it** / **Approve** / **Do it** resolves the item on the Distiller (re-open: it's gone from the feed; `GET /outreach/feed` shows status `acted`).
- [ ] Typing a reply in the overlay and hitting Send routes through `/outreach/:id/reply` and the item clears.
- [ ] During quiet hours (set system clock to 23:30 or temporarily set quietHours), live decisions do NOT banner; they appear in the next digest.
- [ ] Tray shows the pending count badge.
- [ ] Kill the Distiller connection (toggle a VPN): the consumer shows no crash, retries, and nothing is lost when it reconnects.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/OpenAGI/AppDelegate.swift
git commit -m "feat(mac/outreach): start durable consumer on launch when remote main is set"
```

---

## PHASE 7 — Ship

### Task 16: PR + release

- [ ] **Step 1: Push the branch and open a PR**

```bash
git push -u origin feat/proactive-outreach
gh pr create --base main --title "feat: proactive outreach — durable delivery to the Mac" --body "Implements docs/superpowers/specs/2026-06-16-proactive-outreach-design.md"
```

- [ ] **Step 2: After merge, tag a release** (only on the user's explicit "ship it")

```bash
git checkout main && git pull
git tag -a v0.0.9 -m "v0.0.9 — proactive outreach"
git push origin v0.0.9
```

- [ ] **Step 3: Verify the release build is green and assets attached (mirror the v0.0.8 verification).**

---

## Self-Review notes (already applied)

- **Spec coverage:** durable feed (Task 2), no-detection-change mapper (Task 3), stalled surfacing reusing sweep (Task 4), digest + quiet hours + cadence (Tasks 1/5/6), feed/digest/act/reply endpoints + idempotency + delegation (Tasks 7–9), Mac remote pointer + durable consumer + notifications/overlay/tray + quiet hours (Tasks 11–15), config (Task 1), error handling (idempotent act, error status on delegation failure, offline backfill), testing (server `node:test` + Mac manual checklist). All spec sections map to a task.
- **Known verification points to confirm during implementation (not placeholders — explicit checks):** `task-sweep`'s return must expose `flaggedTasks` (Task 6 Step 6); the real task-cancel method name (Task 8 Step 3 note); the `channels` test seam in `hosted-interface.js` (Task 9 Step 3). Each step says exactly what to grep/adjust.

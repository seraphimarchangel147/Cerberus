import path from "node:path";
import { ensureDir, writeJsonAtomic, readJsonFile } from "./file-utils.js";
import { createId, nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

// Where the agent's draft-only work lands for human review — the surface
// that makes "a drafted email is waiting for you" real instead of buried
// in a session transcript.
//
// The agent, working a draft-only plan-action task, calls save_draft
// instead of sending anything. The draft sits here pending until the user
// approves / edits / discards it. Approving NEVER sends on its own —
// sending stays a separate, explicit, approval-gated action. Approve just
// means "this is good"; the user (or a later explicit step) does the send.
//
// Schema for a draft:
//   { id, taskId?, kind, title, body, recipient?, status, createdAt,
//     reviewedAt?, editedAt?, sourceMeta }
//   status: "pending" | "approved" | "discarded"
//
// Snapshot-on-write persistence (same posture as ClarificationStore).

export const DRAFT_KINDS = ["email", "message", "doc", "outline", "reply", "other"];

export class DraftStore {
  constructor({ dir, runtime } = {}) {
    this.dir = dir ?? path.join(resolveDataDir(), "drafts");
    this.runtime = runtime ?? null;
    ensureDir(this.dir);
    this.items = new Map();
    this._load();
  }

  bindRuntime(runtime) {
    this.runtime = runtime;
  }

  list({ status = "pending", projectId = null } = {}) {
    const all = [...this.items.values()];
    const scoped = projectId == null
      ? all
      : all.filter((draft) => (draft.projectId ?? "default") === projectId);
    const filtered = status ? scoped.filter((d) => d.status === status) : scoped;
    return filtered.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
  }

  get(id, { projectId = null } = {}) {
    const draft = this.items.get(id) ?? null;
    if (
      draft
      && projectId != null
      && (draft.projectId ?? "default") !== projectId
    ) {
      return null;
    }
    return draft;
  }

  /// Save a draft for review. `kind` is normalized to a known type so the
  /// UI can pick an icon; unknown kinds collapse to "other".
  add({
    id = null,
    taskId,
    kind,
    title,
    body,
    recipient,
    sourceMeta,
    projectId = "default"
  } = {}) {
    const draftId = id === null ? createId("draft") : String(id);
    if (!/^draft_[a-f0-9]{16}$/u.test(draftId)) {
      throw new TypeError("draft id is invalid");
    }
    if (this.items.has(draftId)) throw new Error(`draft already exists: ${draftId}`);
    const draft = {
      id: draftId,
      projectId: String(projectId || "default"),
      taskId: taskId ?? null,
      kind: DRAFT_KINDS.includes(kind) ? kind : "other",
      title: String(title ?? "").trim() || "(untitled draft)",
      body: String(body ?? ""),
      recipient: recipient ?? null,
      status: "pending",
      createdAt: nowIso(),
      reviewedAt: null,
      editedAt: null,
      sourceMeta: sourceMeta ?? {}
    };
    if (!draft.body.trim()) throw new Error("draft requires a body");
    this.items.set(draft.id, draft);
    try {
      this.snapshot();
    } catch (error) {
      this.items.delete(draft.id);
      throw error;
    }
    try {
      this.runtime?.events?.emit?.("draft-created", draft);
    } catch {
      // Persistence is authoritative; observers cannot roll back a saved draft.
    }
    return draft;
  }

  /// Edit a pending draft's body/title/recipient in place (user tweaks
  /// before approving). No-op fields are left unchanged.
  edit(id, patch = {}, { projectId = null } = {}) {
    const d = this.get(id, { projectId });
    if (!d || d.status !== "pending") return null;
    if (patch.title !== undefined) d.title = String(patch.title).trim() || d.title;
    if (patch.body !== undefined) d.body = String(patch.body);
    if (patch.recipient !== undefined) d.recipient = patch.recipient;
    d.editedAt = nowIso();
    this.snapshot();
    this.runtime?.events?.emit?.("draft-updated", d);
    return d;
  }

  approve(id, options = {}) {
    return this._resolve(id, "approved", options);
  }

  discard(id, options = {}) {
    return this._resolve(id, "discarded", options);
  }

  /// Mark a draft as actually sent, recording how. Only the send endpoint
  /// calls this, AFTER a real transport confirmed delivery. Accepts a
  /// pending OR approved draft (you can send straight from review).
  markSent(id, { channel, target, result, projectId = null } = {}) {
    const d = this.get(id, { projectId });
    if (!d || (d.status !== "pending" && d.status !== "approved")) return null;
    d.status = "sent";
    d.reviewedAt = d.reviewedAt ?? nowIso();
    d.sentAt = nowIso();
    d.sentVia = { channel: channel ?? null, target: target ?? null };
    if (result !== undefined) d.sendResult = result;
    this.snapshot();
    this.runtime?.events?.emit?.("draft-resolved", { draft: d, status: "sent" });
    return d;
  }

  _resolve(id, status, { projectId = null } = {}) {
    const d = this.get(id, { projectId });
    if (!d || d.status !== "pending") return null;
    d.status = status;
    d.reviewedAt = nowIso();
    this.snapshot();
    this.runtime?.events?.emit?.("draft-resolved", { draft: d, status });
    return d;
  }

  snapshot() {
    writeJsonAtomic(path.join(this.dir, "snapshot.json"), {
      version: 1,
      writtenAt: nowIso(),
      items: [...this.items.values()]
    });
  }

  _load() {
    const snap = readJsonFile(path.join(this.dir, "snapshot.json"), null);
    if (!snap) return;
    for (const d of snap.items ?? []) this.items.set(d.id, d);
  }
}

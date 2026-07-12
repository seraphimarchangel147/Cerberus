// src/node-registry.js
// Two small pieces: (1) every installation's own stable identity, generated
// once and persisted regardless of whether it's paired to anything; (2) a
// file-backed registry of *other* nodes, kept by whichever installation is
// acting as a main (i.e. has received at least one heartbeat). A node counts
// "online" if its last heartbeat arrived within ONLINE_WINDOW_MS (3x the 30s
// send interval used by the heartbeat sender in node-heartbeat-sender.js) —
// missing up to 2 heartbeats in a row doesn't flip it offline, only 3+.
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";

export const ONLINE_WINDOW_MS = 90_000;
export const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export function readOrCreateIdentity(dataDir = resolveDataDir()) {
  const filePath = path.join(dataDir, "identity.json");
  const existing = readJsonFile(filePath, null);
  if (existing?.nodeId) return existing;
  const identity = { nodeId: crypto.randomUUID(), name: os.hostname() || "openagi" };
  writeJsonAtomic(filePath, identity);
  return identity;
}

export class NodeRegistry {
  constructor({ dir } = {}) {
    this.dir = dir ?? path.join(resolveDataDir(), "nodes");
    ensureDir(this.dir);
    this.storePath = path.join(this.dir, "registry.json");
  }

  upsert({ nodeId, name, role, url, version }, { now = Date.now() } = {}) {
    this.prune({ now });
    const store = this._read();
    const existing = store.entries[nodeId];
    store.entries[nodeId] = {
      nodeId,
      name,
      role,
      url,
      version,
      firstSeenAt: existing?.firstSeenAt ?? new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString()
    };
    writeJsonAtomic(this.storePath, store);
  }

  list({ now = Date.now() } = {}) {
    const store = this._read();
    return Object.values(store.entries)
      .map((entry) => ({
        ...entry,
        status: (now - new Date(entry.lastSeenAt).getTime()) <= ONLINE_WINDOW_MS ? "online" : "offline"
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  prune({ now = Date.now() } = {}) {
    const store = this._read();
    let removed = 0;
    for (const [nodeId, entry] of Object.entries(store.entries)) {
      if ((now - new Date(entry.lastSeenAt).getTime()) > PRUNE_AFTER_MS) {
        delete store.entries[nodeId];
        removed += 1;
      }
    }
    if (removed > 0) writeJsonAtomic(this.storePath, store);
    return removed;
  }

  _read() {
    return readJsonFile(this.storePath, { version: 1, entries: {} });
  }
}

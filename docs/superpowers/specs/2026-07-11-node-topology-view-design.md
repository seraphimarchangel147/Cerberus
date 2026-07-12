# Node Topology View — Design

## Problem

There is no way, anywhere in the app, to see which machines exist, which one is acting as "main," or whether a given node's pairing is actually live. `~/.openagi/node.json` (`{remote, token}`) is written by `openagi pair` and read only by the CLI (`openagi chat/status/doctor`) — the running daemon itself never reads its own pairing file, and there is no registry of nodes anywhere. Confirmed directly against `src/hosted-interface.js`: the dashboard's tab set (`VALID_TABS`) has no "nodes" entry, and no `/nodes` route exists.

## Goal

A "Nodes" tab in the dashboard, viewable from any installation (main or node), that shows: this machine's own role and pairing status, and a roster of every known node with online/offline status and last-seen time — falling back to a cached, clearly-marked-stale view if the roster can't be freshly fetched.

## Architecture

Four pieces:

1. **Self-identity** (new): a small persisted `{ nodeId, name }` record, generated lazily on first use (not tied to pairing — every installation has an identity regardless of whether it's paired to anything).
2. **Heartbeat sender** (new, runs on every install that is paired): every 30s, POSTs `{ nodeId, name, role: "node", url, version }` to the main named in `node.json`, authenticated with the pairing token already stored there.
3. **Node registry** (main-side, file-backed): upserts a record per `nodeId` on each heartbeat received; a node is "online" if `lastSeenAt` is within 90s (3 missed heartbeats), else "offline." Old entries (unseen 30+ days) are pruned.
4. **`GET /nodes`** (dual behavior) + **dashboard tab**: an instance with a registry (i.e. something has heartbeated to it) serves its registry directly, always including a synthesized self-entry (role="main", always online — if you can reach this endpoint, this machine is up). An instance that is itself paired (has a `node.json`) instead proxies `GET /nodes` to its main, caching the result; if the proxy fetch fails, it serves the last cached roster with `stale: true` and a `cachedAt` timestamp instead of an empty tab.

## Data shapes

```
// registry entry (main-side store, one per node)
{ nodeId: string, name: string, role: "node", url: string, version: string,
  firstSeenAt: ISO8601, lastSeenAt: ISO8601 }

// self-identity (every installation)
{ nodeId: string, name: string }   // name defaults to os.hostname()

// GET /nodes response
{ self: { nodeId, name, role: "main"|"node", version, pairedTo: string|null },
  nodes: [ { ...registry entry, status: "online"|"offline" } ],
  stale: boolean, cachedAt: ISO8601|null }
```

## Data flow

1. On boot, if `node.json` exists, the daemon starts a 30s interval: POST heartbeat to `<node.json.remote>/nodes/heartbeat` with the pairing token as Bearer auth. Failures are logged once per failure-streak (matching the existing cron overlap-guard log pattern), not per-attempt.
2. `POST /nodes/heartbeat` (main-side, auth-gated like every other route): upserts the sender's entry in the registry store, keyed by `nodeId`.
3. `GET /nodes`: mode is decided solely by whether `node.json` exists on this instance. No `node.json` → this instance is a standalone/main: serve the registry store + synthesized self-entry directly (even if the registry is currently empty — a main with zero nodes yet still returns its own self-entry, not an error). Has `node.json` → this instance is paired: proxy `GET /nodes` from `node.json.remote`, cache the response body to `~/.openagi/nodes/cache.json` with a `cachedAt` stamp, and return it (`stale: false`). On proxy failure, return the cached file with `stale: true`.
4. Dashboard "Nodes" tab (`renderNodes`, following the exact pattern of `renderChannels`): fetches `GET /nodes`, shows the self-card first, then a roster table; shows a "showing cached topology as of Xm ago" banner when `stale: true`.

## Error handling

- Heartbeat POST fails (main unreachable): retried next interval; never crashes the sender loop; one log line per failure-streak start, one on recovery (same shape as the D1 cron overlap-guard logging built earlier this week).
- `GET /nodes` proxy fails and no cache exists yet (fresh node, never successfully fetched): return `{ self, nodes: [], stale: true, cachedAt: null }` — the dashboard shows just the self-card with a "topology unavailable yet" note, not an error page.
- Registry writes are file-backed + atomic (matching `writeJsonAtomic` used throughout the codebase), so a crash mid-write can't corrupt the store.
- Auth: heartbeat and `/nodes` both go through the existing Bearer-token gate (`auth.js`) — a node's stored pairing token must already be valid, since pairing itself requires the main's token.

## Testing

- `node-registry.js`: upsert (new + update-existing), online/offline threshold at exactly 90s, pruning of 30-day-stale entries.
- Heartbeat sender: posts the correct payload/auth on schedule; a failed POST doesn't throw or stop the interval; recovery after failure logs once.
- `GET /nodes` on a main: returns registry + synthesized self-entry.
- `GET /nodes` on a node: successful proxy caches the response; a forced proxy failure returns the cached body with `stale: true`; a node with no cache yet returns the "unavailable" shape, not an error.
- Dashboard: `renderNodes` renders the self-card, the roster table, and the stale banner when applicable (matching the existing render-function test conventions where they exist).

## Out of scope (explicitly)

- Multi-level hierarchies (a node that is itself also a main to sub-nodes) — the current real topology is one main + one node; the design doesn't block this but doesn't build for it either.
- A live animated request-flow trace (the "is my request going where I think" idea from the brainstorm) — this spec is the static topology roster only, per the user's own prioritization.
- Any change to the Swift Mac app UI — this is the web dashboard only. The Mac app's own "capture destination" setting (a separate, already-known gap from tonight's earlier work) is unrelated and not touched here.

#!/usr/bin/env node
/**
 * ambient-collector — zero-token ambient activity producer.
 *
 * Replaces the LLM cron tick: samples the Windows host's windows via the
 * daemon's HTTP MCP lane, diffs the focused window against a state file,
 * and POSTs observations ONLY when focus actually changes.
 *
 * Cost per run: two HTTP calls worst case. No model involved.
 *
 * Exit codes: 0 always (fail-silent by design — a dead tick retries next timer).
 */

import { readFileSync, writeFileSync } from "node:fs";

const DAEMON = process.env.OPENAGI_DAEMON_URL || "http://127.0.0.1:43210";
const STATE =
  process.env.AMBIENT_STATE_FILE ||
  "/home/usapcool/.openagi/workspace/ambient-last-focus.json";
const SECRET_RE =
  /(api[_-]?key|token|secret|password|bearer|sk-[a-z0-9]{16,}|AIza[a-z0-9_-]{20,})/gi;

function stripCredentials(s) {
  return String(s || "").replace(SECRET_RE, "[redacted]").slice(0, 120);
}

async function post(path, body) {
  const res = await fetch(DAEMON + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

async function main() {
  // 1. Sample windows through the daemon's MCP HTTP lane.
  const reply = await post("/mcp/call", {
    server: "cua",
    tool: "list_windows",
    arguments: {},
  });
  const windows = reply?.result?.windows || reply?.windows || [];
  if (!windows.length) return; // empty sample = bridge hiccup; stay silent

  // 2. Focus key = top-z window (first entry), matching prior behavior.
  const top = windows[0];
  const app = stripCredentials(top.app || top.process || "unknown");
  const title = stripCredentials(top.title || "");
  const focusKey = `${app}::${title}`;

  // 3. Diff against persisted state.
  let state = {};
  try {
    state = JSON.parse(readFileSync(STATE, "utf8"));
  } catch {}
  if (state.focus === focusKey) return; // unchanged -> silence

  // 4. Focus changed: post observations.
  const observations = windows.map((w, i) => ({
    kind: "activity",
    app: stripCredentials(w.app || w.process || "unknown"),
    window: stripCredentials(w.title || ""),
    event: i === 0 ? "focus" : "visible",
  }));
  await post("/observations", { observations, sourceMachineId: "wsl-host" });

  // 5. Persist new state (single line, overwrite).
  writeFileSync(
    STATE,
    JSON.stringify({ focus: focusKey, at: new Date().toISOString() }),
  );
}

main().catch(() => process.exit(0)); // fail-silent: next timer tick retries

// Ambient digest — deterministically rolls a window of ambient observations
// (app focus events + window titles) into one compact digest the runtime
// feeds into the Signals→Scrutiny→Memory loop as an "ambient-capture" ABI
// signal (see AbiRuntime.runAmbientDigest). One digest per hour, not a
// firehose: G1's fix is that the loop RUNS on the capture stream at all.
//
// No LLM anywhere in this module. Privacy: the digest carries app names,
// window-title tokens, and aggregate counts only — raw OCR text never enters
// the summary or stats. Only `activity` rows are read; frame/OCR rows are
// deliberately excluded (the sqlite no-query search path never returns them,
// and the JSONL fallback rows are filtered out by kind below).
//
// Returns null when the window contains no activity rows so the hourly cron
// job stays completely quiet while the machine is idle: no signal, no memory
// write, no output record.

const MAX_ROWS = 2000; // far above any real single-hour activity volume
const TOP_APP_LIMIT = 3;
const TOP_TOKEN_LIMIT = 5;
const MIN_TOKEN_LENGTH = 3;

export function slugifyApp(app) {
  const slug = String(app ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unknown";
}

export async function buildAmbientDigest({ observations, sinceMs, nowMs = Date.now() } = {}) {
  if (!observations || typeof observations.search !== "function") return null;
  const windowEndMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const windowStartMs = Number.isFinite(sinceMs) ? sinceMs : windowEndMs - 60 * 60 * 1000;
  const since = new Date(windowStartMs).toISOString();
  const until = new Date(windowEndMs).toISOString();

  // No `query` → the sqlite path returns activity-table rows only; the JSONL
  // fallback returns every record kind, so filter to activity explicitly.
  const rows = await observations.search({ since, until, limit: MAX_ROWS });
  const activity = rows.filter((r) => r.kind === "activity");
  if (activity.length === 0) return null;

  const appCounts = new Map();
  const tokenCounts = new Map();
  let focusEvents = 0;
  for (const row of activity) {
    const app = row.app ? String(row.app) : "unknown";
    // record() defaults a missing event to "focus" on the sqlite path; the
    // JSONL fallback keeps the raw record, so treat an absent event the same.
    if ((row.event ?? "focus") === "focus") {
      focusEvents += 1;
      appCounts.set(app, (appCounts.get(app) ?? 0) + 1);
    }
    for (const token of String(row.window ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length < MIN_TOKEN_LENGTH) continue;
      if (/^[0-9]+$/.test(token)) continue;
      tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
    }
  }
  // Activity rows with zero focus events would leave no dominant app to
  // derive a domain from — treat that window as idle too.
  if (focusEvents === 0) return null;

  const topApps = [...appCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_APP_LIMIT)
    .map(([app, count]) => ({ app, count }));
  const topWindowTokens = [...tokenCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_TOKEN_LIMIT)
    .map(([token]) => token);

  const domain = `app-${slugifyApp(topApps[0].app)}`;
  const stats = {
    windowStart: since,
    windowEnd: until,
    focusEvents,
    distinctApps: appCounts.size,
    topApps,
    topWindowTokens
  };
  const appLine = topApps.map((a) => `${a.app} (${a.count})`).join(", ");
  const tokenLine = topWindowTokens.length > 0 ? ` Top window terms: ${topWindowTokens.join(", ")}.` : "";
  const summary = `Ambient activity ${since} to ${until}: ${focusEvents} focus events across ${stats.distinctApps} app${stats.distinctApps === 1 ? "" : "s"}. Top apps: ${appLine}.${tokenLine}`;

  return { domain, summary, stats };
}

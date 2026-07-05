// src/outreach-digest.js
// Roll unseen, non-decision items into a single digest item, on cadence,
// suppressed during quiet hours. Decisions are delivered live, not here.
// Seen skill items that remain unresolved for 48h+ are re-listed under a
// "Still waiting" section, throttled to once per item per 24h.
function plural(n, word) { return `${n} ${word}${n === 1 ? "" : "s"}`; }

const STILL_WAITING_AGE_MS = 48 * 60 * 60 * 1000;
const STILL_WAITING_NUDGE_MS = 24 * 60 * 60 * 1000;

export function composeDigest(store, config, { now = new Date() } = {}) {
  if (config.inQuietHours(now)) return null;
  const pending = store.list({ status: "unseen" })
    .filter((i) => !i.needsDecision && config.digestTypes.includes(i.type));

  const stillWaiting = store.list({ status: "seen" }).filter((i) => {
    if (i.type !== "skill") return false;
    const age = now.getTime() - Date.parse(i.createdAt ?? "");
    if (!Number.isFinite(age) || age < STILL_WAITING_AGE_MS) return false;
    const lastNudge = Date.parse(i.lastNudgedAt ?? "");
    return !Number.isFinite(lastNudge) || (now.getTime() - lastNudge >= STILL_WAITING_NUDGE_MS);
  });

  if (pending.length === 0 && stillWaiting.length === 0) return null;

  const counts = {};
  for (const i of pending) counts[i.type] = (counts[i.type] ?? 0) + 1;
  const parts = Object.entries(counts).map(([type, n]) => plural(n, type));
  if (stillWaiting.length > 0) parts.push(plural(stillWaiting.length, "still-waiting skill"));

  const lines = pending.slice(0, 8).map((i) => `• ${i.title}`);
  if (stillWaiting.length > 0) {
    lines.push("Still waiting:");
    lines.push(...stillWaiting.slice(0, 8).map((i) => `• ${i.title}`));
  }

  const item = store.append({
    type: "digest",
    title: `Your queue: ${parts.join(" · ")}`,
    summary: lines.join("\n"),
    needsDecision: false,
    actions: ["review", "dismiss"]
  });
  store.markSeen(pending.map((i) => i.id));
  store.markNudged?.(stillWaiting.map((i) => i.id), { now });
  return item;
}

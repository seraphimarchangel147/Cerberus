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
  store.markSeen(pending.map((i) => i.id));
  return item;
}

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

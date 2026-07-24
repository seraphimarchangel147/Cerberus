// src/outreach-stalled.js
// Turn task-sweep's "flagged stale" tasks into stalled-task decisions, deduped
// against any still-open stalled-task item for the same task id.
export function surfaceStalledTasks(store, flaggedTasks = []) {
  const openTasks = new Set(
    store.list()
      .filter((i) => i.type === "stalled-task" && (i.status === "unseen" || i.status === "seen"))
      .map((i) => `${i.projectId ?? "default"}:${i.sourceRef?.id}`)
  );
  let created = 0;
  for (const t of flaggedTasks) {
    const projectId = t?.projectId ?? t?.sourceMeta?.projectId ?? "default";
    if (!t?.id || openTasks.has(`${projectId}:${t.id}`)) continue;
    store.append({
      projectId,
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

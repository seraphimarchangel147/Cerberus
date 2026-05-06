// D4 — Vocabulary curator. Tracks tag frequency + last-seen across all
// memory items, proposes merges for near-synonym tags, and deprecates
// tags unused for `dormancyDays`.

const SIM_MERGE_THRESHOLD = 0.82; // Jaro-Winkler-ish prefix overlap
const MIN_USAGE_FOR_MERGE = 5;
const DEFAULT_DORMANCY_DAYS = 60;

export class VocabularyCurator {
  constructor(options = {}) {
    this.runtime = options.runtime;
    this.dormancyDays = options.dormancyDays ?? DEFAULT_DORMANCY_DAYS;
  }

  snapshot() {
    const counts = new Map();
    const lastSeen = new Map();
    for (const item of this.runtime.memory.items.values()) {
      const at = item.lastAccessedAt ?? item.createdAt;
      for (const tag of item.tags ?? []) {
        const t = String(tag).toLowerCase();
        counts.set(t, (counts.get(t) ?? 0) + 1);
        const prev = lastSeen.get(t);
        if (!prev || at > prev) lastSeen.set(t, at);
      }
    }
    return {
      total: counts.size,
      tags: [...counts.entries()]
        .map(([tag, count]) => ({ tag, count, lastSeen: lastSeen.get(tag) }))
        .sort((a, b) => b.count - a.count)
    };
  }

  proposeMerges() {
    const snap = this.snapshot();
    const merges = [];
    const tags = snap.tags.filter((t) => t.count >= MIN_USAGE_FOR_MERGE);
    for (let i = 0; i < tags.length; i += 1) {
      for (let j = i + 1; j < tags.length; j += 1) {
        const a = tags[i].tag;
        const b = tags[j].tag;
        const sim = stringSimilarity(a, b);
        if (sim >= SIM_MERGE_THRESHOLD) {
          // Merge the less-used into the more-used.
          const winner = tags[i].count >= tags[j].count ? a : b;
          const loser = winner === a ? b : a;
          merges.push({ winner, loser, similarity: Number(sim.toFixed(3)), winnerCount: Math.max(tags[i].count, tags[j].count) });
        }
      }
    }
    return merges;
  }

  proposeDeprecations(now = new Date()) {
    const snap = this.snapshot();
    const cutoff = (now instanceof Date ? now.getTime() : new Date(now).getTime()) - this.dormancyDays * 86400 * 1000;
    return snap.tags.filter((t) => {
      const ts = t.lastSeen ? new Date(t.lastSeen).getTime() : 0;
      return ts < cutoff;
    });
  }

  applyMerges(merges) {
    const applied = [];
    for (const m of merges) {
      let touched = 0;
      for (const item of this.runtime.memory.items.values()) {
        if (!item.tags?.length) continue;
        let changed = false;
        const next = [];
        for (const t of item.tags) {
          if (String(t).toLowerCase() === m.loser) {
            if (!next.includes(m.winner)) next.push(m.winner);
            changed = true;
          } else if (!next.includes(t)) {
            next.push(t);
          }
        }
        if (changed) {
          item.tags = next;
          touched += 1;
        }
      }
      applied.push({ ...m, touched });
    }
    if (typeof this.runtime.memory.persist === "function") this.runtime.memory.persist("vocab-merge", { applied });
    return applied;
  }
}

function stringSimilarity(a, b) {
  if (a === b) return 1;
  // Simple measure: shared character n-gram count / max possible.
  const aBi = bigrams(a);
  const bBi = bigrams(b);
  if (aBi.size === 0 || bBi.size === 0) return 0;
  let shared = 0;
  for (const x of aBi) if (bBi.has(x)) shared += 1;
  return (2 * shared) / (aBi.size + bBi.size);
}

function bigrams(s) {
  const out = new Set();
  const t = String(s).toLowerCase();
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  return out;
}

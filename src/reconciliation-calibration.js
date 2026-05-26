// Self-tuning reconciliation thresholds — closes the learning loop the
// clarification queue opened.
//
// Every clarification answer is recorded as an outcome with metadata
// { proposedAction, proposedConfidence, sources, answer }. A clarification
// is only ever created in the ambiguous band (proposed "complete" at
// 0.4–0.7), so the answers tell us, per evidence-source combination, how
// often our mid-band "this looks done" instinct was actually right:
//
//   high "yes" rate → we were usually right to want to complete; we asked
//     needlessly. LOWER the auto-complete threshold for that combo so
//     similar future cases auto-complete instead of generating a question.
//   low "yes" rate → good thing we asked; we'd have been wrong. RAISE the
//     threshold so the clarification band catches more.
//
// Bounded to [0.6, 0.85] — always safely above the 0.4 clarification floor,
// never so high nothing auto-completes. Per-combo calibration falls back to
// a pooled global calibration, then to the 0.7 base, depending on how much
// data exists. Pure functions → trivially testable, no I/O.

export const BASE_COMPLETE_THRESHOLD = 0.7;
const MIN_BOUND = 0.6;
const MAX_BOUND = 0.85;
const MIN_COMBO_SAMPLES = 6; // need this many answers for a combo to self-tune
const MIN_GLOBAL_SAMPLES = 10; // pooled fallback needs a bit more

function comboKey(sources) {
  return (Array.isArray(sources) ? sources.filter((s) => typeof s === "string") : [])
    .slice()
    .sort()
    .join("+") || "none";
}

// yesRate → threshold. Monotonic: the more often we were right, the lower
// (more permissive) the bar.
function thresholdFromYesRate(yesRate) {
  if (yesRate >= 0.8) return MIN_BOUND;        // 0.60
  if (yesRate >= 0.65) return 0.65;
  if (yesRate <= 0.2) return MAX_BOUND;        // 0.85
  if (yesRate <= 0.35) return 0.8;
  return BASE_COMPLETE_THRESHOLD;              // 0.70 — inconclusive
}

// Build a calibration table from clarification-answered outcomes.
// Returns { thresholdFor(sources), summary }.
export function buildReconciliationCalibration(outcomes = []) {
  // Group answers by source combo. We only count "yes" vs "not-yes" since
  // "yes" is the signal that our complete-instinct was correct. ("dropped"
  // / "no" / "in_progress" all mean it was NOT done at scan time.)
  const byCombo = new Map(); // key → { total, yes }
  let globalTotal = 0;
  let globalYes = 0;

  for (const o of outcomes) {
    if (o.kind !== "clarification-answered") continue;
    const m = o.metadata ?? {};
    if (m.proposedAction && m.proposedAction !== "complete") continue;
    const key = comboKey(m.sources);
    const bucket = byCombo.get(key) ?? { total: 0, yes: 0 };
    bucket.total += 1;
    if (m.answer === "yes") bucket.yes += 1;
    byCombo.set(key, bucket);
    globalTotal += 1;
    if (m.answer === "yes") globalYes += 1;
  }

  const globalRate = globalTotal > 0 ? globalYes / globalTotal : null;

  const thresholdFor = (sources) => {
    const key = comboKey(sources);
    const combo = byCombo.get(key);
    if (combo && combo.total >= MIN_COMBO_SAMPLES) {
      return { threshold: thresholdFromYesRate(combo.yes / combo.total), basis: "combo", key, samples: combo.total, yesRate: round(combo.yes / combo.total) };
    }
    if (globalTotal >= MIN_GLOBAL_SAMPLES && globalRate !== null) {
      return { threshold: thresholdFromYesRate(globalRate), basis: "global", key, samples: globalTotal, yesRate: round(globalRate) };
    }
    return { threshold: BASE_COMPLETE_THRESHOLD, basis: "default", key, samples: combo?.total ?? 0, yesRate: combo ? round(combo.yes / combo.total) : null };
  };

  const summary = {
    base: BASE_COMPLETE_THRESHOLD,
    bounds: [MIN_BOUND, MAX_BOUND],
    globalSamples: globalTotal,
    globalYesRate: globalRate === null ? null : round(globalRate),
    combos: [...byCombo.entries()].map(([key, v]) => ({
      sources: key,
      samples: v.total,
      yesRate: round(v.yes / v.total),
      threshold: v.total >= MIN_COMBO_SAMPLES ? thresholdFromYesRate(v.yes / v.total) : BASE_COMPLETE_THRESHOLD
    })).sort((a, b) => b.samples - a.samples)
  };

  return { thresholdFor, summary };
}

function round(n) {
  return Number(n.toFixed(3));
}

/**
 * The scorer — per-entity precision/recall/F1 from a detector's output against the corpus's
 * labels (spec 2026-08-25-pseudonymization-precision, task 4).
 *
 * Deliberately independent of the pseudonymization plugin: this module imports nothing
 * from `src/plugins/pseudonymization`, only the plain `EntityLabel`/`Span` shapes. That is
 * what lets the SAME scorer (and the SAME corpus) run against the shipped `detectEntities`
 * and, unmodified, against the `30747f6` baseline detectors copied into a temp dir outside
 * the repo — see precision.test.ts for how the baseline numbers were produced and where
 * they are recorded.
 *
 * Two matching modes:
 *
 *   - `exact`   — a predicted span counts as a true positive only when its start, end AND
 *     type are identical to a label's. This is what the technical-set precision gate and
 *     the prose-set recall gate use: it is the strict reading of "did the detector produce
 *     the value the operator would see unmasked or masked".
 *   - `overlap` — a predicted span counts as a true positive when it OVERLAPS a label of
 *     the same type at all, so a detector that masks "Dear Ferreira Nakamura" instead of
 *     "Ferreira Nakamura" is not penalised for the extra token. Reported alongside `exact`
 *     for every set, never used to gate a threshold — a looser mode that decided pass/fail
 *     would hide exactly the span-boundary regressions this harness exists to catch.
 *
 * Matching is per-type, one-to-one (greedy, sorted by start): a label can be claimed by at
 * most one predicted span and vice versa, so a detector that fires twice on the same value
 * is not credited twice.
 */

export interface Span {
  start: number;
  end: number;
  type: string;
}

export interface Counts {
  tp: number;
  fp: number;
  fn: number;
}

export interface Scores extends Counts {
  precision: number;
  recall: number;
  f1: number;
}

export type MatchMode = 'exact' | 'overlap';

function matches(mode: MatchMode, label: Span, predicted: Span): boolean {
  if (label.type !== predicted.type) return false;
  if (mode === 'exact') return label.start === predicted.start && label.end === predicted.end;
  return label.start < predicted.end && label.end > predicted.start;
}

/**
 * Score one document: greedy one-to-one matching, per type, so overlapping candidates of
 * the same type cannot double-claim a label or a prediction.
 */
export function scoreCase(labels: Span[], predicted: Span[], mode: MatchMode): Counts {
  const claimedLabels = new Set<number>();
  const claimedPredicted = new Set<number>();

  // Sort by start so a leftmost match is preferred when several candidates could claim the
  // same label — deterministic, and irrelevant in practice since the corpus has no case
  // with two same-type overlapping labels.
  const labelOrder = labels.map((_, i) => i).sort((a, b) => labels[a].start - labels[b].start);

  for (const li of labelOrder) {
    const label = labels[li];
    for (let pi = 0; pi < predicted.length; pi++) {
      if (claimedPredicted.has(pi)) continue;
      if (matches(mode, label, predicted[pi])) {
        claimedLabels.add(li);
        claimedPredicted.add(pi);
        break;
      }
    }
  }

  const tp = claimedLabels.size;
  const fn = labels.length - tp;
  const fp = predicted.length - claimedPredicted.size;
  return { tp, fp, fn };
}

function toScores(c: Counts): Scores {
  // Convention: no predictions and no labels is vacuously perfect (nothing was owed and
  // nothing was claimed); a non-empty denominator uses the ordinary ratio.
  const precision = c.tp + c.fp === 0 ? 1 : c.tp / (c.tp + c.fp);
  const recall = c.tp + c.fn === 0 ? 1 : c.tp / (c.tp + c.fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { ...c, precision, recall, f1 };
}

function sumCounts(a: Counts, b: Counts): Counts {
  return { tp: a.tp + b.tp, fp: a.fp + b.fp, fn: a.fn + b.fn };
}

export interface SetScores {
  overall: Scores;
  byType: Record<string, Scores>;
}

/**
 * Score a whole set of documents. `overall` aggregates raw counts across every document and
 * every type (micro-averaged — a type with more labels weighs proportionally more), then
 * derives one precision/recall/F1 from the totals. `byType` does the same, split per entity
 * type, for the per-entity breakdown the task-4 report records.
 */
export function scoreSet(
  cases: Array<{ labels: Span[]; predicted: Span[] }>,
  mode: MatchMode,
): SetScores {
  let overall: Counts = { tp: 0, fp: 0, fn: 0 };
  const byTypeCounts: Record<string, Counts> = {};

  for (const { labels, predicted } of cases) {
    const types = new Set<string>([...labels.map(l => l.type), ...predicted.map(p => p.type)]);
    for (const type of types) {
      const typedLabels = labels.filter(l => l.type === type);
      const typedPredicted = predicted.filter(p => p.type === type);
      const counts = scoreCase(typedLabels, typedPredicted, mode);
      overall = sumCounts(overall, counts);
      byTypeCounts[type] = sumCounts(byTypeCounts[type] ?? { tp: 0, fp: 0, fn: 0 }, counts);
    }
  }

  const byType: Record<string, Scores> = {};
  for (const [type, counts] of Object.entries(byTypeCounts)) {
    byType[type] = toScores(counts);
  }

  return { overall: toScores(overall), byType };
}

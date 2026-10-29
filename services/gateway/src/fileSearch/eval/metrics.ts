/**
 * Retrieval metrics for the file_search evaluation (ci/file-search-eval, runner in
 * scripts/file-search-eval.ts). Pure: no I/O and no normalising of its own. Callers pass chunk and
 * quote text already normalised with ci/file-search-eval/normalise.js, the one normaliser the
 * question generator also checked every quote with.
 *
 * Relevance: a returned chunk is relevant to a question when it contains any of the question's
 * quotes ('exact'), or, for a quote cut by a chunk boundary, a contiguous piece of it at least 60% of
 * the quote's length ('fragment'). The caller decides which chunks may match at all (the runner
 * admits only chunks of the question's own file or files).
 *
 * A question is a hit at k when its quotes are covered within the top k results: any quote for a
 * single-passage question, every quote for a multihop one ('all'; the 'any' variant is reported
 * separately). recall@k is the share of questions that are hits at k; MRR averages 1 / the rank at
 * which a question became a hit (0 when it never did). nDCG@10 is binary and per quote: each quote
 * gains 1/log2(r+1) at the first rank r <= 10 that covers it, and the ideal places every quote at
 * rank 1 (one chunk may hold several quotes), so nDCG@10 is the mean of those gains. A second chunk
 * holding an already covered quote adds nothing.
 */
export type QuestionKind = 'markdown' | 'pdf' | 'table' | 'scanned' | 'multihop' | 'pptx' | 'xlsx';
export const QUESTION_KINDS: readonly QuestionKind[] = ['markdown', 'pdf', 'table', 'scanned', 'multihop', 'pptx', 'xlsx'];

export const FRAGMENT_RATIO = 0.6;
export const RECALL_KS = [5, 10, 20] as const;
export const NDCG_K = 10;

export type MatchVia = 'exact' | 'fragment';
export type HitRule = 'all' | 'any';

/** 'exact' when the chunk contains the whole quote, 'fragment' when it contains a contiguous piece
 *  of at least ceil(ratio x length) characters of it, otherwise null. Both arguments normalised. */
export function matchQuote(chunk: string, quote: string, ratio: number = FRAGMENT_RATIO): MatchVia | null {
  if (!quote) return null;
  if (chunk.includes(quote)) return 'exact';
  // A common piece of length >= n exists exactly when one of length n does.
  const n = Math.max(1, Math.ceil(quote.length * ratio));
  for (let start = 0; start + n <= quote.length; start++) {
    if (chunk.includes(quote.slice(start, start + n))) return 'fragment';
  }
  return null;
}

/** The quotes one result covers, by quote index. */
export interface RankMatch {
  /** 1-based position in the returned list. */
  rank: number;
  exact: number[];
  fragment: number[];
}

/** The ranks that cover at least one quote. `chunks[i]` is rank i + 1; null means "may not match"
 *  (a chunk of another file). */
export function matchResults(chunks: Array<string | null>, quotes: string[]): RankMatch[] {
  const matches: RankMatch[] = [];
  chunks.forEach((chunk, i) => {
    if (chunk === null) return;
    const m: RankMatch = { rank: i + 1, exact: [], fragment: [] };
    quotes.forEach((quote, q) => {
      const via = matchQuote(chunk, quote);
      if (via === 'exact') m.exact.push(q);
      else if (via === 'fragment') m.fragment.push(q);
    });
    if (m.exact.length + m.fragment.length > 0) matches.push(m);
  });
  return matches;
}

export interface QuestionOutcome {
  id: string;
  kind: QuestionKind;
  quoteCount: number;
  /** How many results the search returned. */
  returned: number;
  matches: RankMatch[];
  latencyMs: number;
}

export function ruleFor(kind: QuestionKind): HitRule {
  return kind === 'multihop' ? 'all' : 'any';
}

/** The first rank covering each quote, null when no returned result covers it. */
export function quoteRanks(o: QuestionOutcome, allowFragment = true): Array<number | null> {
  const ranks: Array<number | null> = new Array(o.quoteCount).fill(null);
  for (const m of [...o.matches].sort((a, b) => a.rank - b.rank)) {
    for (const q of allowFragment ? [...m.exact, ...m.fragment] : m.exact) {
      if (ranks[q] === null) ranks[q] = m.rank;
    }
  }
  return ranks;
}

/** The rank at which the question became a hit under `rule`, or null. */
export function hitRank(o: QuestionOutcome, rule: HitRule = ruleFor(o.kind), allowFragment = true): number | null {
  const ranks = quoteRanks(o, allowFragment);
  if (ranks.length === 0) return null;
  if (rule === 'all') return ranks.some((r) => r === null) ? null : Math.max(...(ranks as number[]));
  const found = ranks.filter((r): r is number => r !== null);
  return found.length ? Math.min(...found) : null;
}

/** True when the question's hit exists, or comes earlier, only because of the fragment rule. */
export function hitNeedsFragment(o: QuestionOutcome, rule: HitRule = ruleFor(o.kind)): boolean {
  const full = hitRank(o, rule, true);
  if (full === null) return false;
  const exact = hitRank(o, rule, false);
  return exact === null || exact > full;
}

export function ndcgAt(o: QuestionOutcome, k: number = NDCG_K): number {
  if (o.quoteCount === 0) return 0;
  const gains = quoteRanks(o).map((r) => (r !== null && r <= k ? 1 / Math.log2(r + 1) : 0));
  return gains.reduce((a, b) => a + b, 0) / o.quoteCount;
}

export interface Summary {
  questions: number;
  recall: Record<string, number>;
  mrr: number;
  ndcg10: number;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

/** Metrics over `outcomes`; `rule` overrides each question's own hit rule (for the multihop 'any' line). */
export function summarise(outcomes: QuestionOutcome[], rule?: HitRule): Summary {
  const ranks = outcomes.map((o) => hitRank(o, rule ?? ruleFor(o.kind)));
  const recall: Record<string, number> = {};
  for (const k of RECALL_KS) recall[String(k)] = mean(ranks.map((r) => (r !== null && r <= k ? 1 : 0)));
  return {
    questions: outcomes.length,
    recall,
    mrr: mean(ranks.map((r) => (r === null ? 0 : 1 / r))),
    ndcg10: mean(outcomes.map((o) => ndcgAt(o, NDCG_K))),
  };
}

/** Nearest-rank percentile (p in 0..100); null for no values. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export interface EvaluationMetrics {
  overall: Summary;
  byKind: Partial<Record<QuestionKind, Summary>>;
  /** Multihop questions counted as hits when ANY of their quotes is covered. */
  multihopAnyQuote: Summary | null;
  latencyMs: { p50: number | null; p95: number | null };
  /** Questions whose hit exists, or ranks higher, only because of the 60% fragment rule. */
  fragmentRuleHits: number;
}

export function evaluateOutcomes(outcomes: QuestionOutcome[]): EvaluationMetrics {
  const byKind: Partial<Record<QuestionKind, Summary>> = {};
  for (const kind of QUESTION_KINDS) {
    const of = outcomes.filter((o) => o.kind === kind);
    if (of.length) byKind[kind] = summarise(of);
  }
  const multihop = outcomes.filter((o) => o.kind === 'multihop');
  const latencies = outcomes.map((o) => o.latencyMs);
  return {
    overall: summarise(outcomes),
    byKind,
    multihopAnyQuote: multihop.length ? summarise(multihop, 'any') : null,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    fragmentRuleHits: outcomes.filter((o) => hitNeedsFragment(o)).length,
  };
}

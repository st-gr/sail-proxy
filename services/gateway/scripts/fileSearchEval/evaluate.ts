/**
 * Runs every question through a search function and decides relevance. The search is injected (the
 * runner passes the real `searchVectorStores`, tests a fake), as is the meter: before each question
 * `meter.ensure(estimate)` may stop the run, which then returns what it has, marked incomplete.
 */
import { matchResults, QuestionKind, QuestionOutcome } from '../../src/fileSearch/eval/metrics';
import { BudgetExceededError, Meter } from './costMeter';

/** Results requested per question: recall@20 is the deepest metric. */
export const RESULTS_PER_QUERY = 20;
/** Consecutive failed searches after which the run stops: the cause is not the question. */
export const MAX_CONSECUTIVE_ERRORS = 3;

export interface EvalQuestion {
  id: string;
  question: string;
  file: string;
  kind: QuestionKind;
  quotes: string[];
  files?: string[];
}

export interface SearchHitText { filename: string; text: string }
export interface SearchAnswer { hits: SearchHitText[]; mode: string }

export interface QuestionRecord {
  id: string;
  kind: QuestionKind;
  mode?: string;
  returned?: number;
  /** The ranks that cover a quote: exact and fragment quote indices. */
  matches?: QuestionOutcome['matches'];
  latencyMs?: number;
  /** Tokens of the returned texts: the first 5 results (what the judge answers from) and all. */
  returnedTokens?: { top5: number; all: number };
  error?: string;
}

export interface EvaluationRun {
  outcomes: QuestionOutcome[];
  records: QuestionRecord[];
  complete: boolean;
  stopReason: string | null;
  modes: Record<string, number>;
  /** Top results per question id, kept only for the ids in `keepHitsFor` (the judge sample). */
  hits: Map<string, SearchHitText[]>;
}

export interface EvaluateDeps {
  search: (query: string) => Promise<SearchAnswer>;
  meter: Meter;
  estimateUsd: (q: EvalQuestion) => number;
  normalise: (text: string) => string;
  keepHitsFor?: Set<string>;
  /** Counts the returned texts' tokens per question when given (parent sections return more text). */
  countTokens?: (text: string) => number;
  now?: () => number;
  log?: (message: string) => void;
}

/** A message safe to store: the error's name and the first line of its message, shortened. */
export function safeError(error: unknown): string {
  const e = error as { name?: string; message?: string } | undefined;
  const message = String(e?.message ?? error).split('\n')[0].slice(0, 160);
  return `${e?.name ?? 'Error'}: ${message}`;
}

export async function evaluateQuestions(questions: EvalQuestion[], deps: EvaluateDeps): Promise<EvaluationRun> {
  const now = deps.now ?? (() => performance.now());
  const log = deps.log ?? (() => {});
  const run: EvaluationRun = { outcomes: [], records: [], complete: true, stopReason: null, modes: {}, hits: new Map() };
  let consecutiveErrors = 0;

  for (const [i, q] of questions.entries()) {
    try {
      deps.meter.ensure(deps.estimateUsd(q));
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      run.complete = false;
      run.stopReason = `${error.message} (before question ${i + 1} of ${questions.length})`;
      break;
    }

    const started = now();
    let answer: SearchAnswer;
    try {
      // eslint-disable-next-line no-await-in-loop
      answer = await deps.search(q.question);
    } catch (error) {
      run.records.push({ id: q.id, kind: q.kind, error: safeError(error) });
      consecutiveErrors += 1;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        run.complete = false;
        run.stopReason = `${MAX_CONSECUTIVE_ERRORS} consecutive searches failed; last: ${safeError(error)}`;
        break;
      }
      continue;
    }
    consecutiveErrors = 0;
    const latencyMs = Math.round(now() - started);

    // Only chunks of the question's own file(s) may match; quotes are unique to their file, and this
    // keeps a short quote's 60% fragment from matching another document.
    const allowed = new Set(q.files ?? [q.file]);
    const texts = answer.hits.map((h) => (allowed.has(h.filename) ? deps.normalise(h.text) : null));
    const matches = matchResults(texts, q.quotes.map(deps.normalise));
    const outcome: QuestionOutcome = {
      id: q.id, kind: q.kind, quoteCount: q.quotes.length, returned: answer.hits.length, matches, latencyMs,
    };
    run.outcomes.push(outcome);
    const record: QuestionRecord = { id: q.id, kind: q.kind, mode: answer.mode, returned: answer.hits.length, matches, latencyMs };
    if (deps.countTokens) {
      const tokens = answer.hits.map((h) => deps.countTokens!(h.text));
      const sum = (ns: number[]) => ns.reduce((a, n) => a + n, 0);
      record.returnedTokens = { top5: sum(tokens.slice(0, 5)), all: sum(tokens) };
    }
    run.records.push(record);
    run.modes[answer.mode] = (run.modes[answer.mode] ?? 0) + 1;
    if (deps.keepHitsFor?.has(q.id)) run.hits.set(q.id, answer.hits);

    if ((i + 1) % 10 === 0 || i + 1 === questions.length) {
      log(`[${i + 1}/${questions.length}] $${deps.meter.snapshot().spentUsd.toFixed(4)} spent`);
    }
  }
  return run;
}

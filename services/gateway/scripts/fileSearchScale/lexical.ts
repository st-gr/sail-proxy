/**
 * The full-text OR arm at scale: today's arm, the arm without the lexemes that table statistics
 * call common (lexicalBound.ts commonLexemes over pg_stats of tsv and context_tsv, share > theta),
 * the arm that ranks a bounded set (every chunk with all the terms plus at most `ceiling` other
 * matches), and both together - the last, at theta COMMON_LEXEME_SHARE and the ceiling
 * OR_ARM_RANKED_SET_CEILING, is what recall runs for a search over more than exact_max_chunks
 * chunks. Chunk text is Zipf-distributed (see `chunkTextSql`), so a question can be put together
 * from terms of a known share of chunks.
 */
import type { ClientBase } from 'pg';
import {
  BOUNDED_OR_QUERY_SQL, OR_QUERY_SQL, ORDERED_SCAN_SETTINGS_SQL, SERIAL_FILES_SCAN_SQL, SERIAL_SCAN_SQL,
} from '../../src/fileSearch/repository';
import { storeAccessPredicateSql } from '../../src/fileSearch/recallSql';
import { COMMON_LEXEMES_SQL, commonLexemes } from '../../src/fileSearch/lexicalBound';
import { STOP_WORDS } from '../../src/fileSearch/stopWords';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const probe = require('../../../../cli-tools/file-search-recall-probe.js') as {
  tieAwareRecall: (exact: Array<{ id: string; score: number }>, ann: Array<{ id: string; score: number }>) => number;
  summarize: (values: number[]) => Stat;
};

export interface Stat { n: number; mean: number | null; min: number | null; p50: number | null; p95: number | null; max: number | null }

/** Vocabulary size: words `lx1` .. `lxV`, rank 1 the most frequent. */
export const VOCABULARY = 50000;

/** Each word of a chunk is rank floor(exp(u * ln(V+1))), u uniform: P(r) = ln((r+1)/r) / ln(V+1). */
export function termProbability(rank: number, vocabulary: number): number {
  return Math.log((rank + 1) / rank) / Math.log(vocabulary + 1);
}

/** The share of chunks of `words` words that contain the term of `rank`. */
export function chunkFraction(rank: number, vocabulary: number, words: number): number {
  return 1 - (1 - termProbability(rank, vocabulary)) ** words;
}

/** The most frequent rank whose chunk share is at most `target` (V when none is that rare). */
export function rankForFraction(target: number, vocabulary: number, words: number): number {
  let lo = 1;
  let hi = vocabulary;
  if (chunkFraction(vocabulary, vocabulary, words) > target) return vocabulary;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (chunkFraction(mid, vocabulary, words) <= target) hi = mid; else lo = mid + 1;
  }
  return lo;
}

/** One chunk's text, evaluated per row (`rowRef` correlates the sub-select so it is not run once). */
export function chunkTextSql(words: number, rowRef: string): string {
  return `(SELECT string_agg('lx' || floor(exp(random() * ln(${VOCABULARY + 1})))::int, ' ')
             FROM generate_series(1, ${words} + 0 * ${rowRef}))`;
}

/**
 * The lexical arm as recall builds it (recallSql.ts buildArm with the ts_rank score): a chunks-only
 * inner query ranked and bounded by `$4`, the joins outside. $1 store ids, $2 owner, $3 the arm's
 * tsquery, $4 limit, $5 the question's full OR tsquery (ranked for the returned rows only, for the
 * tie-aware comparison); `bounded` (orArmRankedSetSql): $6 the ceiling and $7 the AND query, and
 * the inner query then ranks every chunk with all the terms plus at most $6 other matches. The bench
 * searches as a caller in no team (an empty team-id array where recall binds the caller's).
 */
export function lexicalArmSql({ bounded }: { bounded: boolean }): string {
  const stores = `FROM vector_stores vs
          WHERE vs.id = ANY($1)
            AND ${storeAccessPredicateSql("'{}'::text[]")}`;
  const where = (match: string, filesPredicate = '') => `WHERE c.store_id = ANY($1)
      AND c.store_id = ANY(ARRAY(
          SELECT vs.id ${stores}))
      AND (c.store_id || ':' || c.generation) = ANY(ARRAY(
          SELECT vs.id || ':' || vs.active_generation ${stores}))
      AND EXISTS (
          SELECT 1 FROM vector_store_files vsf
          WHERE vsf.store_id = c.store_id AND vsf.file_id = c.file_id${filesPredicate})
      AND ${match}`;
  const match = (q: string) => `(c.tsv @@ ${q} OR c.context_tsv @@ ${q})`;
  const score = "ts_rank(c.tsv || coalesce(c.context_tsv, ''::tsvector), $3::tsquery)";
  // The columns orArmRankedSetSql selects (the text and structure columns travel with each candidate).
  const branch = (m: string, limit: string, filesPredicate = '') => `SELECT c.store_id, c.file_id, c.ord, c.text, c.generation, c.section,
             c.section_offset, c.context, c.page_start, c.page_end, c.tsv, c.context_tsv
      FROM vector_store_chunks c
      ${where(m, filesPredicate)}
      LIMIT ${limit}`;
  const source = !bounded ? `vector_store_chunks c
    ${where(match('$3::tsquery'))}` : `(
      (${branch(match('$7::tsquery'), '$4')})
      UNION ALL
      (${branch(`${match('$3::tsquery')} AND ${match('$7::tsquery')} IS NOT TRUE AND ${SERIAL_SCAN_SQL}`, '$6', ` AND ${SERIAL_FILES_SCAN_SQL}`)})
    ) c`;
  return `
SELECT k.store_id, k.file_id, k.ord, f.filename,
       ROW_NUMBER() OVER (ORDER BY k.score DESC, k.store_id, k.file_id, k.ord) AS rnk,
       k.score, ts_rank(c2.tsv || coalesce(c2.context_tsv, ''::tsvector), $5::tsquery) AS full_score
  FROM (
    SELECT c.store_id, c.file_id, c.ord, c.generation, ${score} AS score
    FROM ${source}
    ORDER BY ${score} DESC, c.store_id, c.file_id, c.ord
    LIMIT $4
  ) k
  JOIN vector_store_chunks c2 ON c2.store_id = k.store_id AND c2.file_id = k.file_id
                             AND c2.generation = k.generation AND c2.ord = k.ord
  JOIN vector_store_files vsf ON vsf.store_id = k.store_id AND vsf.file_id = k.file_id
  JOIN fs_files f ON f.id = k.file_id
 ORDER BY rnk`;
}

export interface LexicalQuestion { name: string; text: string }

/** Questions from terms of known chunk shares (`words` words per chunk). */
export function lexicalQuestions(words: number): LexicalQuestion[] {
  const term = (fraction: number) => `lx${rankForFraction(fraction, VOCABULARY, words)}`;
  const spread = Array.from({ length: 32 }, (_, i) => term(0.5 * (0.0002 / 0.5) ** (i / 31)));
  return [
    { name: 'half + 2 rare', text: `${term(0.5)} ${term(0.001)} ${term(0.0005)}` },
    { name: '3 common', text: `${term(0.5)} ${term(0.2)} ${term(0.1)}` },
    { name: '32 terms', text: spread.join(' ') },
    { name: '3 rare', text: `${term(0.001)} ${term(0.0005)} ${term(0.0002)}` },
    { name: 'no match', text: 'qqzzy unknownterm' },
  ];
}

export interface LexicalVariantResult {
  question: string;
  variant: string;
  terms: number;
  /** Whether the AND of every term already finds `limit` chunks (then recall never runs the OR arm). */
  andIsEnough: boolean;
  firstMs: number;
  ms: Stat;
  rows: number;
  /** Tie-aware recall@limit against today's OR arm, on the full question's rank. */
  agreement: number;
}

const REPEATS = 5;

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const started = process.hrtime.bigint();
  const value = await fn();
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, value };
}

/** The OR and AND queries of `text` as recall builds them: today's, or (with `common`) a large search's. */
async function orQuery(client: ClientBase, text: string, common: string[] | null): Promise<{ q: string | null; qAnd: string | null; terms: number }> {
  const { rows } = common === null
    ? await client.query(OR_QUERY_SQL, [text, STOP_WORDS])
    : await client.query(BOUNDED_OR_QUERY_SQL, [text, STOP_WORDS, common]);
  const q: string | null = rows[0].q;
  return { q, qAnd: rows[0].q_and, terms: q ? q.split(' | ').length : 0 };
}

export async function measureLexical(
  client: ClientBase,
  opts: { storeId: string; owner: string; limit: number; words: number; thetas: number[]; ceilings: number[] },
  log: (m: string) => void,
): Promise<{ statsCommon: Record<string, number>; results: LexicalVariantResult[] }> {
  const { rows: statRows } = await client.query(COMMON_LEXEMES_SQL);
  const common = (theta: number) => commonLexemes(statRows, theta);
  const statsCommon: Record<string, number> = {};
  for (const theta of opts.thetas) statsCommon[String(theta)] = common(theta).length;

  const baseSql = lexicalArmSql({ bounded: false });
  const ceilingSql = lexicalArmSql({ bounded: true });
  const results: LexicalVariantResult[] = [];
  for (const question of lexicalQuestions(opts.words)) {
    /* eslint-disable no-await-in-loop */
    const full = await orQuery(client, question.text, null);
    let andIsEnough = false;
    if (full.qAnd) {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM (SELECT 1 FROM vector_store_chunks c WHERE c.store_id = $1
           AND c.tsv @@ $2::tsquery LIMIT $3) m`, [opts.storeId, full.qAnd, opts.limit]);
      andIsEnough = rows[0].n >= opts.limit;
    }
    const variants: Array<{ name: string; sql: string; common: string[] | null; ceiling: number | null }> = [
      { name: 'today', sql: baseSql, common: null, ceiling: null },
      ...opts.thetas.map((t) => ({ name: `theta ${t}`, sql: baseSql, common: common(t), ceiling: null })),
      ...opts.ceilings.map((c) => ({ name: `ceiling ${c}`, sql: ceilingSql, common: null, ceiling: c })),
      ...opts.thetas.flatMap((t) => opts.ceilings.map((c) => ({
        name: `theta ${t} + ceiling ${c}`, sql: ceilingSql, common: common(t), ceiling: c }))),
    ];
    let baseline: Array<{ id: string; score: number }> = [];
    for (const v of variants) {
      const query = await orQuery(client, question.text, v.common);
      const run = async () => {
        if (!query.q) return [] as any[];
        const params: unknown[] = [[opts.storeId], opts.owner, query.q, opts.limit, full.q];
        if (v.ceiling !== null) params.push(v.ceiling, query.qAnd);
        await client.query('BEGIN');
        try {
          await client.query('SET LOCAL jit = off');
          if (v.ceiling !== null) await client.query(ORDERED_SCAN_SETTINGS_SQL);
          return (await client.query(v.sql, params)).rows;
        } finally {
          await client.query('ROLLBACK');
        }
      };
      const first = await timed(run);
      const times: number[] = [];
      let rows: any[] = first.value;
      for (let i = 0; i < REPEATS; i += 1) {
        const t = await timed(run);
        times.push(t.ms);
        rows = t.value;
      }
      // Descending ranks as ascending "distances" for the probe's tie-aware recall.
      const ranked = rows.map((r) => ({ id: `${r.store_id}/${r.file_id}/${r.ord}`, score: -Number(r.full_score) }));
      if (v.name === 'today') baseline = ranked;
      const result: LexicalVariantResult = {
        question: question.name, variant: v.name, terms: query.terms, andIsEnough, firstMs: first.ms,
        ms: probe.summarize(times), rows: rows.length, agreement: probe.tieAwareRecall(baseline, ranked),
      };
      results.push(result);
      log(`lexical ${question.name} / ${v.name}: ${query.terms} terms, p50 ${result.ms.p50?.toFixed(1)} ms, `
        + `${rows.length} rows, agreement ${result.agreement.toFixed(3)}`);
    }
    /* eslint-enable no-await-in-loop */
  }
  return { statsCommon, results };
}

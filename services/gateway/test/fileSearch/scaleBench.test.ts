import { EventEmitter } from 'events';
import { containerAction, installSignalCleanup } from '../../scripts/fileSearchScale/database';
import { indexDdl, parseArgs, parseIndexConfigs } from '../../scripts/fileSearchScale/options';
import {
  chunkFraction, lexicalArmSql, rankForFraction, termProbability,
} from '../../scripts/fileSearchScale/lexical';
import { distanceGap, summarizeAnn } from '../../scripts/fileSearchScale/vectors';
import { benchStores, sameSpec, TENANT_CHUNKS } from '../../scripts/fileSearchScale/load';

describe('file_search scale bench: arguments', () => {
  it('applies the defaults', () => {
    const o = parseArgs([]);
    expect(o).toMatchObject({ dims: 1536, vectors: 'clustered', words: 120, queries: 20, limit: 50, lexical: false,
      thetas: [0.02, 0.05, 0.1], ceilings: [5000], insert: 2000, maintenanceWorkMem: '1GB', keepDb: false, dsn: null,
      out: null, tenants: 200 });
    expect(o.stores).toEqual([1000, 2000, 5000, 10000, 20000, 50000, 200000]);
    expect(o.indexes).toEqual([{ kind: 'halfvec', efConstruction: 200, parallel: false }]);
  });

  it('measures several ranked-set ceilings', () => {
    expect(parseArgs(['--ceiling', '2000, 5000,20000']).ceilings).toEqual([2000, 5000, 20000]);
    expect(() => parseArgs(['--ceiling', '2000,'])).toThrow();
  });

  it('parses every option', () => {
    const o = parseArgs(['--dims', '384', '--stores', '2000, 1000000', '--vectors', 'random', '--words', '60',
      '--index', 'none', '--queries', '5', '--limit', '20', '--lexical', '--theta', '0.05', '--ceiling', '1000',
      '--insert', '0', '--maintenance-work-mem', '2GB', '--keep-db', '--dsn', 'postgresql://x', '--out', 'r.json',
      '--tenants', '0']);
    expect(o).toMatchObject({ dims: 384, stores: [2000, 1000000], vectors: 'random', words: 60, indexes: [],
      queries: 5, limit: 20, lexical: true, thetas: [0.05], ceilings: [1000], insert: 0, maintenanceWorkMem: '2GB',
      keepDb: true, dsn: 'postgresql://x', out: 'r.json', tenants: 0 });
  });

  it.each([
    [['--dims', '0']], [['--dims', '4001']], [['--stores', '']], [['--stores', '10,x']], [['--vectors', 'real']],
    [['--theta', '1.5']], [['--theta', '0']], [['--maintenance-work-mem', '1GB; DROP']], [['--index', 'vector:64']],
    [['--queries']], [['--bogus']], [['--dims', '2001', '--index', 'vector:64:serial']],
  ])('rejects %j', (argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });

  it('accepts a halfvec index above 2000 dimensions', () => {
    expect(parseArgs(['--dims', '3072', '--index', 'halfvec:200:serial']).dims).toBe(3072);
  });
});

describe('file_search scale bench: index configurations', () => {
  it('parses kind:ef_construction:serial|parallel lists', () => {
    expect(parseIndexConfigs('vector:64:serial, halfvec:200:parallel')).toEqual([
      { kind: 'vector', efConstruction: 64, parallel: false },
      { kind: 'halfvec', efConstruction: 200, parallel: true },
    ]);
    expect(parseIndexConfigs('none')).toEqual([]);
  });

  it.each(['vector:64', 'bit:64:serial', 'vector:3:serial', 'vector:64:fast', 'vector:x:serial'])('rejects %s', (s) => {
    expect(() => parseIndexConfigs(s)).toThrow();
  });

  it('builds the plain and the halfvec expression index', () => {
    expect(indexDdl({ kind: 'vector', efConstruction: 64, parallel: false }, 1536)).toBe(
      'CREATE INDEX idx_chunks_hnsw ON vector_store_chunks USING hnsw (embedding vector_cosine_ops) '
      + 'WITH (m = 16, ef_construction = 64)');
    expect(indexDdl({ kind: 'halfvec', efConstruction: 200, parallel: true }, 1536)).toBe(
      'CREATE INDEX idx_chunks_hnsw ON vector_store_chunks USING hnsw ((embedding::halfvec(1536)) '
      + 'halfvec_cosine_ops) WITH (m = 16, ef_construction = 200)');
  });
});

describe('file_search scale bench: Zipf text', () => {
  const V = 50000;

  it('gives rank r the probability ln((r+1)/r) / ln(V+1), summing to 1', () => {
    expect(termProbability(1, V)).toBeCloseTo(Math.log(2) / Math.log(V + 1), 12);
    let sum = 0;
    for (let r = 1; r <= V; r += 1) sum += termProbability(r, V);
    expect(sum).toBeCloseTo(1, 9);
  });

  it('turns a term probability into the share of chunks that contain the term', () => {
    expect(chunkFraction(1, V, 1)).toBeCloseTo(termProbability(1, V), 12);
    expect(chunkFraction(1, V, 120)).toBeGreaterThan(0.99);
    expect(chunkFraction(20000, V, 120)).toBeLessThan(0.001);
  });

  it('finds the most frequent rank whose chunk share is at most the target', () => {
    const r = rankForFraction(0.5, V, 120);
    expect(chunkFraction(r, V, 120)).toBeLessThanOrEqual(0.5);
    expect(chunkFraction(r - 1, V, 120)).toBeGreaterThan(0.5);
    expect(rankForFraction(1, V, 120)).toBe(1);
    expect(rankForFraction(1e-12, V, 120)).toBe(V);
  });
});

describe('file_search scale bench: the full-text OR arm', () => {
  it('mirrors recall\'s lexical arm: a ranked, bounded, chunks-only inner query', () => {
    const sql = lexicalArmSql({ bounded: false });
    expect(sql).toMatch(/ORDER BY ts_rank\(c\.tsv \|\| coalesce\(c\.context_tsv, ''::tsvector\), \$3::tsquery\) DESC, c\.store_id, c\.file_id, c\.ord\s+LIMIT \$4/);
    expect(sql).toMatch(/\(c\.tsv @@ \$3::tsquery OR c\.context_tsv @@ \$3::tsquery\)/);
    // The store line recall's arms start with (the planner reads the store statistics), and no vector predicate.
    expect(sql).toMatch(/WHERE c\.store_id = ANY\(\$1\)\n\s+AND c\.store_id = ANY\(ARRAY\(/);
    expect(sql).not.toMatch(/embedding/);
    // The full question's rank, for the tie-aware comparison, only for the returned rows.
    expect(sql).toMatch(/ts_rank\(c2\.tsv \|\| coalesce\(c2\.context_tsv, ''::tsvector\), \$5::tsquery\) AS full_score/);
    const inner = /FROM \(([\s\S]*)\) k\n/.exec(sql)?.[1] ?? '';
    expect(inner).toMatch(/LIMIT \$4/);
    expect(inner).not.toMatch(/\$5/);
    expect(sql).not.toMatch(/\$6|\$7/);
  });

  it('bounded: every chunk with all the terms plus at most the ceiling\'s other matches, as recall ranks them', () => {
    const sql = lexicalArmSql({ bounded: true });
    expect(sql).toMatch(/AND \(c\.tsv @@ \$7::tsquery OR c\.context_tsv @@ \$7::tsquery\)\n\s+LIMIT \$4\)\n\s+UNION ALL/);
    expect(sql).toMatch(/AND \(c\.tsv @@ \$3::tsquery OR c\.context_tsv @@ \$3::tsquery\) AND \(c\.tsv @@ \$7::tsquery OR c\.context_tsv @@ \$7::tsquery\) IS NOT TRUE AND c\.ord <> -pg_backend_pid\(\)\n\s+LIMIT \$6\)\n\s+\) c/);
    expect(sql.match(/WHERE c\.store_id = ANY\(\$1\)/g)).toHaveLength(2);
  });
});

describe('file_search scale bench: ANN summary', () => {
  const q = (o: Partial<{ recall: number; exactCount: number; annCount: number; exactMs: number; annMs: number;
    gap: number }>) => ({ recall: 1, exactCount: 50, annCount: 50, exactMs: 10, annMs: 2, gap: 0, ...o });

  it('adds the exact re-run to a short ANN answer and counts it as recall 1', () => {
    const s = summarizeAnn([q({}), q({ annCount: 10, recall: 0.2 }), q({ recall: 0.4 })], 50);
    expect(s.underReturned).toBe(1);
    expect(s.failures).toBe(2);
    expect(s.recall.mean).toBeCloseTo((1 + 0.2 + 0.4) / 3);
    expect(s.recallAfterRerun.mean).toBeCloseTo((1 + 1 + 0.4) / 3);
    expect(s.annMs.max).toBe(2);
    expect(s.effectiveMs.max).toBe(12);
  });

  it('re-runs whenever ANN returns fewer than limit rows (the app cannot know the exact count), '
    + 'without counting it as under-returned', () => {
    const s = summarizeAnn([q({ exactCount: 7, annCount: 7 })], 50);
    expect(s.underReturned).toBe(0);
    expect(s.reruns).toBe(1);
    expect(s.effectiveMs.max).toBe(12);
  });
});

describe('file_search scale bench: distance gap', () => {
  const rows = (scores: number[]) => scores.map((score, i) => ({ id: `r${i}`, score }));

  it('is the relative excess of the mean ANN distance over the mean exact distance', () => {
    expect(distanceGap(rows([0.1, 0.3]), rows([0.1, 0.3]))).toBe(0);
    expect(distanceGap(rows([0.1, 0.3]), rows([0.1, 0.5]))).toBeCloseTo(0.5);
  });

  it('compares over the rows ANN returned, and is 0 without rows', () => {
    expect(distanceGap(rows([0.1, 0.3, 0.5]), rows([0.1]))).toBe(0);
    expect(distanceGap([], [])).toBe(0);
  });

  it('is summarized per store as the mean and maximum', () => {
    const s = summarizeAnn([{ recall: 1, exactCount: 50, annCount: 50, exactMs: 1, annMs: 1, gap: 0.01 },
      { recall: 1, exactCount: 50, annCount: 50, exactMs: 1, annMs: 1, gap: 0.03 }], 50);
    expect(s.gap.mean).toBeCloseTo(0.02);
    expect(s.gap.max).toBeCloseTo(0.03);
  });
});

describe('file_search scale bench: load reuse', () => {
  const spec = { version: 2, dims: 1536, stores: [1000, 2000], vectors: 'clustered', words: 200, queries: 20, tenants: 200 };

  it('recognises the stored spec whatever order jsonb gave its keys', () => {
    const fromJsonb = { dims: 1536, words: 200, stores: [1000, 2000], queries: 20, tenants: 200, version: 2,
      vectors: 'clustered' };
    expect(sameSpec(fromJsonb, spec)).toBe(true);
  });

  it('tells a different load apart', () => {
    expect(sameSpec({ ...spec, stores: [2000, 1000] }, spec)).toBe(false);
    expect(sameSpec({ ...spec, words: 120 }, spec)).toBe(false);
    expect(sameSpec(null, spec)).toBe(false);
  });
});

describe('file_search scale bench: stores', () => {
  it('numbers the measured stores and gives each its share of the table, tenant stores included', () => {
    expect(benchStores([1000, 3000], 0)).toEqual([
      { id: 'vs-0', size: 1000, fraction: 0.25 }, { id: 'vs-1', size: 3000, fraction: 0.75 }]);
    const [a] = benchStores([1000, 3000], 10);
    expect(a.fraction).toBeCloseTo(1000 / (4000 + 10 * TENANT_CHUNKS));
  });
});

describe('file_search scale bench: container lifecycle', () => {
  it('reuses only a container that an earlier --keep-db run marked as kept, and replaces any other', () => {
    expect(containerAction('', '')).toBe('start');
    expect(containerAction('running', 'true')).toBe('reuse');
    expect(containerAction('exited', 'true')).toBe('restart');
    expect(containerAction('running', '')).toBe('replace');
    expect(containerAction('exited', 'false')).toBe('replace');
  });

  it('removes the container on SIGINT/SIGTERM/SIGALRM unless --keep-db, then exits with the signal\'s code', () => {
    const proc = new EventEmitter();
    const remove = jest.fn();
    const exit = jest.fn();
    installSignalCleanup({ keepDb: false, remove, exit, proc });
    expect(proc.listenerCount('SIGINT')).toBe(1);
    expect(proc.listenerCount('SIGTERM')).toBe(1);
    expect(proc.listenerCount('SIGALRM')).toBe(1);
    proc.emit('SIGTERM');
    expect(remove).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(143);

    const kept = new EventEmitter();
    const remove2 = jest.fn();
    const exit2 = jest.fn();
    installSignalCleanup({ keepDb: true, remove: remove2, exit: exit2, proc: kept });
    kept.emit('SIGINT');
    expect(remove2).not.toHaveBeenCalled();
    expect(exit2).toHaveBeenCalledWith(130);
  });
});

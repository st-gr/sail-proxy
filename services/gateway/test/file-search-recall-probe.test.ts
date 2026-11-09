import { readFileSync } from 'fs';
import { join } from 'path';
import { describeVectorIndex } from '../src/fileSearch/vectorIndex';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const probe = require('../../../cli-tools/file-search-recall-probe.js');

describe('file-search-recall-probe: arguments', () => {
  it('applies the defaults', () => {
    const opts = probe.parseArgs([]);
    expect(opts).toMatchObject({ queries: 20, limit: 50, minChunks: 1, source: 'self', seed: 'probe',
      stores: null, attribute: null, json: false, dsn: null });
  });

  it('parses every option', () => {
    const opts = probe.parseArgs(['--dsn', 'postgresql://x', '--stores', 'vs_a, vs_b', '--min-chunks', '500',
      '--queries', '5', '--limit', '20', '--source', 'other', '--attribute', 'scope=@sap', '--seed', 's1', '--json']);
    expect(opts).toMatchObject({ dsn: 'postgresql://x', stores: ['vs_a', 'vs_b'], minChunks: 500, queries: 5,
      limit: 20, source: 'other', attribute: { key: 'scope', value: '@sap' }, seed: 's1', json: true });
  });

  it('keeps an "=" inside the attribute value', () => {
    expect(probe.parseArgs(['--attribute', 'k=a=b']).attribute).toEqual({ key: 'k', value: 'a=b' });
  });

  it.each([
    [['--limit', '0']], [['--queries', 'x']], [['--source', 'both']], [['--attribute', '=v']],
    [['--stores']], [['--limit', '--json']], [['--bogus']],
  ])('rejects %j', (argv) => {
    expect(() => probe.parseArgs(argv)).toThrow();
  });
});

describe('file-search-recall-probe: settings', () => {
  it('mirrors today\'s exact-path ef_search (2 x limit, 100..1000)', () => {
    expect(probe.exactEfSearch(10)).toBe(100);
    expect(probe.exactEfSearch(50)).toBe(100);
    expect(probe.exactEfSearch(200)).toBe(400);
    expect(probe.exactEfSearch(900)).toBe(1000);
  });

  it('uses the B2 ANN ef_search clamp(4 x limit, 200, 1000)', () => {
    expect(probe.annEfSearch(10)).toBe(200);
    expect(probe.annEfSearch(50)).toBe(200);
    expect(probe.annEfSearch(100)).toBe(400);
    expect(probe.annEfSearch(400)).toBe(1000);
  });

  it('forces the index only on the ANN path, and turns JIT off on both', () => {
    const ann = probe.annSettings(50).join('; ');
    const exact = probe.exactSettings(50).join('; ');
    expect(ann).toMatch(/enable_sort = off/);
    expect(ann).toMatch(/enable_seqscan = off/);
    expect(ann).toMatch(/enable_bitmapscan = off/);
    expect(ann).toMatch(/iterative_scan = 'relaxed_order'/);
    expect(exact).not.toMatch(/enable_/);
    expect(exact).toMatch(/iterative_scan = 'strict_order'/);
    expect(ann).toMatch(/jit = off/);
    expect(exact).toMatch(/jit = off/);
  });
});

describe('file-search-recall-probe: SQL shape', () => {
  it('orders the exact inner query with the tiebreaker and the ANN one by distance alone', () => {
    const exact = probe.buildArmSql({ ann: false, attribute: null });
    const ann = probe.buildArmSql({ ann: true, attribute: null });
    expect(exact).toMatch(/ORDER BY c\.embedding <=> \$3::vector, c\.store_id, c\.file_id, c\.ord\s+LIMIT \$4/);
    expect(ann).toMatch(/ORDER BY c\.embedding <=> \$3::vector\s+LIMIT \$4/);
    expect(ann).toMatch(/WITH k AS MATERIALIZED/);
    expect(exact).not.toMatch(/MATERIALIZED/);
  });

  it('keeps the owner/shared boundary and the active generation in both', () => {
    for (const ann of [false, true]) {
      const sql = probe.buildArmSql({ ann, attribute: null });
      expect(sql).toMatch(/\(vs\.owner_email = \$2 OR vs\.is_shared = true\)/);
      expect(sql).toMatch(/vs\.id \|\| ':' \|\| vs\.active_generation/);
      expect(sql).not.toMatch(/\$5/);
    }
  });

  it('binds the attribute filter as parameters, never as text', () => {
    const sql = probe.buildArmSql({ ann: true, attribute: { key: "x' OR 1=1 --", value: 'v' } });
    expect(sql).toMatch(/vsf\.attributes ->> \$5 = \$6/);
    expect(sql).not.toMatch(/OR 1=1/);
  });

  it('never compares with, or samples, a chunk stored without a vector', () => {
    for (const ann of [false, true]) {
      expect(probe.buildArmSql({ ann, attribute: null })).toContain('AND c.embedding IS NOT NULL');
    }
    for (const source of ['self', 'other']) {
      expect(probe.buildSampleSql(source)).toContain('WHERE s.embedding IS NOT NULL AND ');
    }
  });

  // recall's store scope (recallSql.ts chunkScopeSql): the requested ids as a bound value first, so the
  // planner reads a small store through the store index on an install with few stores
  it('scopes the chunks as recall does: the requested store ids first, then the readable ones', () => {
    for (const ann of [false, true]) {
      expect(probe.buildArmSql({ ann, attribute: null }))
        .toContain('WHERE c.store_id = ANY($1)\n      AND c.store_id = ANY(ARRAY(\n          SELECT vs.id FROM vector_stores vs');
    }
  });

  it('is read-only SQL', () => {
    for (const ann of [false, true]) {
      expect(probe.buildArmSql({ ann, attribute: null })).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i);
    }
  });
});

describe('file-search-recall-probe: recall and statistics', () => {
  const rows = (pairs: Array<[string, number]>) => pairs.map(([id, score]) => ({ id, score }));

  it('is 1 when the ANN rows are the exact rows', () => {
    const exact = rows([['a', 0.1], ['b', 0.2], ['c', 0.3]]);
    expect(probe.tieAwareRecall(exact, exact)).toBe(1);
  });

  it('counts missing rows as misses', () => {
    const exact = rows([['a', 0.1], ['b', 0.2], ['c', 0.3], ['d', 0.4]]);
    expect(probe.tieAwareRecall(exact, rows([['a', 0.1], ['c', 0.3], ['x', 0.9]]))).toBe(0.5);
    expect(probe.tieAwareRecall(exact, [])).toBe(0);
  });

  it('counts a different chunk tied with the cut-off distance as a hit', () => {
    const exact = rows([['a', 0.1], ['b', 0.3]]);
    expect(probe.tieAwareRecall(exact, rows([['a', 0.1], ['b-twin', 0.3]]))).toBe(1);
  });

  it('does not count a duplicated ANN row twice', () => {
    const exact = rows([['a', 0.1], ['b', 0.2]]);
    expect(probe.tieAwareRecall(exact, rows([['a', 0.1], ['a', 0.1]]))).toBe(0.5);
  });

  it('is 1 when the exact path found nothing', () => {
    expect(probe.tieAwareRecall([], [])).toBe(1);
  });

  it('summarizes values with mean, min, p50, p95 and max', () => {
    const s = probe.summarize(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(s).toEqual({ n: 20, mean: 10.5, min: 1, p50: 10, p95: 19, max: 20 });
    expect(probe.summarize([])).toEqual({ n: 0, mean: null, min: null, p50: null, p95: null, max: null });
  });

  it('counts failures below 0.5 and under-returned queries per store', () => {
    const q = (recall: number, annCount: number) => ({ recall, exactCount: 50, annCount, exactMs: 2, annMs: 1,
      annUsesHnsw: true, exactUsesHnsw: false });
    const s = probe.summarizeStore({ id: 'vs_a', name: 'a', chunks: 500, tableFraction: 0.01 },
      [q(1, 50), q(0.4, 50), q(0.2, 10)]);
    expect(s).toMatchObject({ storeId: 'vs_a', chunks: 500, queries: 3, failures: 2, underReturned: 1,
      annUsesHnsw: true, exactUsesHnsw: false });
    expect(s.recall.min).toBeCloseTo(0.2);
  });

  it('finds an index anywhere in an EXPLAIN plan tree', () => {
    const plan = { 'Node Type': 'Limit', Plans: [{ 'Node Type': 'Nested Loop', Plans: [
      { 'Node Type': 'Index Scan', 'Index Name': 'idx_chunks_hnsw' }] }] };
    expect(probe.planUsesIndex(plan, 'idx_chunks_hnsw')).toBe(true);
    expect(probe.planUsesIndex(plan, 'idx_chunks_store')).toBe(false);
    expect(probe.planUsesIndex(null, 'idx_chunks_hnsw')).toBe(false);
  });
});

describe('file-search-recall-probe: --halfvec', () => {
  it('detects by default; --halfvec forces it on and --no-halfvec off', () => {
    expect(probe.parseArgs([]).halfvec).toBeNull();
    expect(probe.parseArgs(['--halfvec']).halfvec).toBe(true);
    expect(probe.parseArgs(['--no-halfvec']).halfvec).toBe(false);
  });

  it('orders the ANN inner query by the halfvec expression the index is built on, scored at full precision', () => {
    const ann = probe.buildArmSql({ ann: true, attribute: null, halfvecDims: 1536 });
    expect(ann).toMatch(/ORDER BY c\.embedding::halfvec\(1536\) <=> \$3::halfvec\(1536\)\s+LIMIT \$4/);
    expect(ann).toMatch(/c\.embedding <=> \$3::vector AS score/);
    expect(ann).toMatch(/WITH k AS MATERIALIZED/);
  });

  it('leaves the exact path on the full-precision vector with the tiebreaker', () => {
    const exact = probe.buildArmSql({ ann: false, attribute: null, halfvecDims: 1536 });
    expect(exact).toBe(probe.buildArmSql({ ann: false, attribute: null }));
    expect(exact).not.toMatch(/halfvec/);
  });

  it('refuses a halfvec width that is not a positive integer', () => {
    expect(() => probe.buildArmSql({ ann: true, attribute: null, halfvecDims: 0 })).toThrow();
    expect(() => probe.buildArmSql({ ann: true, attribute: null, halfvecDims: '1536; DROP' })).toThrow();
  });
});

// The probe is plain CommonJS and copies the gateway's halfvec regex (vectorIndex.ts); these definitions (the
// fixtures of vectorIndex.test.ts and their variants) keep the two in step.
const INDEX_DEFINITIONS = [
  'CREATE INDEX idx_chunks_hnsw ON public.vector_store_chunks USING hnsw '
    + "(((embedding)::halfvec(1536)) halfvec_cosine_ops) WITH (m='16', ef_construction='200')",
  'CREATE INDEX idx_chunks_hnsw ON public.vector_store_chunks USING hnsw (embedding vector_cosine_ops)',
  'CREATE INDEX idx_chunks_hnsw ON public.vector_store_chunks USING hnsw '
    + "(((embedding)::public.halfvec(3072)) public.halfvec_cosine_ops) WITH (ef_construction='100', m='24')",
  'CREATE INDEX idx_chunks_hnsw ON s.vector_store_chunks USING hnsw '
    + '(((embedding)::"MySchema".halfvec(8)) "MySchema".halfvec_cosine_ops)',
  'CREATE INDEX x ON t USING hnsw (((embedding)::halfvec(8)) halfvec_l2_ops)',
  'CREATE INDEX x ON t USING btree (a)',
  '',
];

describe('file-search-recall-probe: halfvec detection', () => {
  it.each(INDEX_DEFINITIONS.map((d) => [d]))('reads %j as the gateway does', (definition) => {
    const gateway = describeVectorIndex(definition);
    expect(probe.detectHalfvecDims(definition)).toBe(gateway.kind === 'halfvec' ? gateway.dimensions : null);
  });

  it('holds the gateway\'s regex verbatim', () => {
    const source = (file: string) => readFileSync(join(__dirname, file), 'utf8').split('\n')
      .filter((line) => line.startsWith('const QUALIFIER =') || line.includes('String.raw`USING hnsw \\(\\(\\(embedding'));
    const gateway = source('../src/fileSearch/vectorIndex.ts');
    expect(gateway).toHaveLength(2);
    expect(source('../../../cli-tools/file-search-recall-probe.js')).toEqual(gateway);
  });

  it('finds the halfvec kind in the fixtures (the check above is not vacuous)', () => {
    expect(INDEX_DEFINITIONS.map((d) => probe.detectHalfvecDims(d))).toEqual([1536, null, 3072, 8, null, null, null]);
    expect(probe.detectHalfvecDims(null)).toBeNull();
  });

  /** A client that answers the probe's two catalog reads. */
  const fakeClient = (definition: string | null, width = 8, valid = true) => {
    const sent: string[] = [];
    return {
      sent,
      query: async (sql: string) => {
        sent.push(sql);
        if (sql.includes('pg_get_indexdef')) {
          // the probe must read the flag: a definition without it is not a valid index
          return { rows: definition === null ? [] : [{ definition, ...(sql.includes('indisvalid') ? { valid } : {}) }] };
        }
        if (sql.includes('pg_attribute')) return { rows: [{ dims: width }] };
        throw new Error(`unexpected ${sql}`);
      },
    };
  };

  it('without a flag: the halfvec width of idx_chunks_hnsw, else the vector path', async () => {
    expect(await probe.resolveHalfvecDims(fakeClient(INDEX_DEFINITIONS[0]), null)).toEqual({ dims: 1536, how: 'detected' });
    expect(await probe.resolveHalfvecDims(fakeClient(INDEX_DEFINITIONS[1]), null)).toEqual({ dims: null, how: 'not detected' });
    expect(await probe.resolveHalfvecDims(fakeClient(null), null)).toEqual({ dims: null, how: 'not detected' });
  });

  it('an INVALID idx_chunks_hnsw (a failed concurrent build) is not used: the vector path, labelled INVALID', async () => {
    // The gateway orders by halfvec only for a valid index, and the planner ignores an invalid one.
    expect(await probe.resolveHalfvecDims(fakeClient(INDEX_DEFINITIONS[0], 8, false), null)).toEqual({ dims: null, how: 'invalid' });
    expect(await probe.resolveHalfvecDims(fakeClient(INDEX_DEFINITIONS[1], 8, false), null)).toEqual({ dims: null, how: 'invalid' });
  });

  it('--halfvec forces the column width; --no-halfvec reads nothing', async () => {
    const forced = fakeClient(INDEX_DEFINITIONS[1], 384);
    expect(await probe.resolveHalfvecDims(forced, true)).toEqual({ dims: 384, how: '--halfvec' });
    expect(forced.sent.some((s) => s.includes('pg_get_indexdef'))).toBe(false);
    const off = fakeClient(INDEX_DEFINITIONS[0]);
    expect(await probe.resolveHalfvecDims(off, false)).toEqual({ dims: null, how: '--no-halfvec' });
    expect(off.sent).toEqual([]);
  });

  it('names how the ANN path was chosen in the header', () => {
    expect(probe.annOrderLabel({ dims: 1536, how: 'detected' })).toBe('ANN ordered by halfvec(1536) (detected from idx_chunks_hnsw)');
    expect(probe.annOrderLabel({ dims: 384, how: '--halfvec' })).toBe('ANN ordered by halfvec(384) (--halfvec)');
    expect(probe.annOrderLabel({ dims: null, how: 'not detected' })).toBe('ANN ordered by vector (idx_chunks_hnsw is not the halfvec kind)');
    expect(probe.annOrderLabel({ dims: null, how: '--no-halfvec' })).toBe('ANN ordered by vector (--no-halfvec)');
    expect(probe.annOrderLabel({ dims: null, how: 'invalid' })).toBe('ANN ordered by vector (idx_chunks_hnsw is INVALID: '
      + 'the planner ignores it, so the ann figures are an exact scan, not ANN recall; run rebuild-index)');
  });
});

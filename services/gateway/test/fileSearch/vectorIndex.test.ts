// W4 Task 2: the approximate-search index's definition, its recognition from pg_get_indexdef/pg_indexes, and
// the rough sizes and times the rebuild command prints before it builds.
import {
  describeVectorIndex, isHalfvecVectorIndex, halfvecIndexDefinition, pgvectorVersionAtLeast,
  estimateHalfvecIndexBytes, estimateBuildSeconds, VECTOR_INDEX_NAME, VECTOR_INDEX_BUILD_NAME, nonDefaultBuildNote,
} from '../../src/fileSearch/vectorIndex';
import { buildSchemaSql, splitSqlStatements, splitSchemaPhases } from '../../src/fileSearch/schema.sql';

// Verbatim pg_get_indexdef output from pg16.15 / pgvector 0.8.6.
const NEW_KIND = 'CREATE INDEX idx_chunks_hnsw ON public.vector_store_chunks USING hnsw '
  + "(((embedding)::halfvec(1536)) halfvec_cosine_ops) WITH (m='16', ef_construction='200')";
const OLD_KIND = 'CREATE INDEX idx_chunks_hnsw ON public.vector_store_chunks USING hnsw (embedding vector_cosine_ops)';

describe('the index names', () => {
  it('keeps idx_chunks_hnsw and builds beside it as idx_chunks_hnsw_v2', () => {
    expect(VECTOR_INDEX_NAME).toBe('idx_chunks_hnsw');
    expect(VECTOR_INDEX_BUILD_NAME).toBe('idx_chunks_hnsw_v2');
  });
});

describe('halfvecIndexDefinition', () => {
  it('is the halfvec expression index with m 16 and ef_construction 200 by default', () => {
    expect(halfvecIndexDefinition(1536)).toBe(
      'USING hnsw ((embedding::halfvec(1536)) halfvec_cosine_ops) WITH (m = 16, ef_construction = 200)');
  });

  it('takes other build parameters', () => {
    expect(halfvecIndexDefinition(3072, { m: 24, efConstruction: 100 })).toBe(
      'USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops) WITH (m = 24, ef_construction = 100)');
  });

  it.each([0, 4001, 1.5])('refuses width %p', (n) => {
    expect(() => halfvecIndexDefinition(n)).toThrow(/1 to 4000/);
  });
});

describe('describeVectorIndex / isHalfvecVectorIndex', () => {
  it('recognises the new kind and reads its width and parameters', () => {
    expect(describeVectorIndex(NEW_KIND)).toEqual({ kind: 'halfvec', dimensions: 1536, m: 16, efConstruction: 200 });
    expect(isHalfvecVectorIndex(NEW_KIND)).toBe(true);
    expect(isHalfvecVectorIndex(NEW_KIND, 1536)).toBe(true);
    expect(isHalfvecVectorIndex(NEW_KIND, 3072)).toBe(false);
  });

  it('recognises the previous kind with pgvector defaults (m 16, ef_construction 64)', () => {
    expect(describeVectorIndex(OLD_KIND)).toEqual({ kind: 'vector', dimensions: null, m: 16, efConstruction: 64 });
    expect(isHalfvecVectorIndex(OLD_KIND)).toBe(false);
  });

  it('reads parameters in any order and schema-qualified type and operator class names', () => {
    const def = 'CREATE INDEX idx_chunks_hnsw ON s.vector_store_chunks USING hnsw '
      + "(((embedding)::public.halfvec(3072)) public.halfvec_cosine_ops) WITH (ef_construction='100', m='24')";
    expect(describeVectorIndex(def)).toEqual({ kind: 'halfvec', dimensions: 3072, m: 24, efConstruction: 100 });
  });

  it('a halfvec index with another distance is not the new kind', () => {
    const def = 'CREATE INDEX x ON t USING hnsw (((embedding)::halfvec(8)) halfvec_l2_ops)';
    expect(describeVectorIndex(def).kind).toBe('other');
    expect(isHalfvecVectorIndex(def)).toBe(false);
  });

  it('anything else is other, and no index is none', () => {
    expect(describeVectorIndex('CREATE INDEX x ON t USING btree (a)').kind).toBe('other');
    expect(describeVectorIndex(null)).toEqual({ kind: 'none', dimensions: null, m: null, efConstruction: null });
    expect(isHalfvecVectorIndex(undefined)).toBe(false);
  });

  it('round-trips the definition the code builds', () => {
    // what Postgres prints for halfvecIndexDefinition(8, {m: 16, efConstruction: 200})
    const printed = "CREATE INDEX idx_chunks_hnsw ON public.vector_store_chunks USING hnsw (((embedding)::halfvec(8)) halfvec_cosine_ops) WITH (m='16', ef_construction='200')";
    expect(halfvecIndexDefinition(8)).toContain('halfvec(8)');
    expect(describeVectorIndex(printed)).toEqual({ kind: 'halfvec', dimensions: 8, m: 16, efConstruction: 200 });
  });
});

describe('nonDefaultBuildNote', () => {
  const halfvec = (m: number, efConstruction: number) => describeVectorIndex(
    'CREATE INDEX idx_chunks_hnsw ON public.vector_store_chunks USING hnsw '
    + `(((embedding)::halfvec(8)) halfvec_cosine_ops) WITH (m='${m}', ef_construction='${efConstruction}')`);

  it('is null for the defaults, the previous kind, any other index and none', () => {
    expect(nonDefaultBuildNote(describeVectorIndex(NEW_KIND))).toBeNull();
    expect(nonDefaultBuildNote(describeVectorIndex(OLD_KIND))).toBeNull(); // has its own boot line
    expect(nonDefaultBuildNote(describeVectorIndex('CREATE INDEX x ON t USING btree (a)'))).toBeNull();
    expect(nonDefaultBuildNote(null)).toBeNull();
  });

  it('names a lower ef_construction or m as lower recall, and how to get the defaults', () => {
    expect(nonDefaultBuildNote(halfvec(16, 64))).toBe('built with ef_construction 64 (default 200): lower recall than the '
      + 'defaults the approximate search was measured with; rebuild-index without --m or --ef-construction rebuilds it with the defaults');
    expect(nonDefaultBuildNote(halfvec(8, 200))).toMatch(/^built with m 8 \(default 16\): lower recall than/);
    expect(nonDefaultBuildNote(halfvec(24, 100))).toMatch(/^built with ef_construction 100 \(default 200\) and m 24 \(default 16\): lower recall/);
  });

  it('names higher values without claiming lower recall', () => {
    expect(nonDefaultBuildNote(halfvec(24, 400))).toMatch(
      /^built with ef_construction 400 \(default 200\) and m 24 \(default 16\): not the defaults the approximate search was measured with;/);
  });
});

describe('pgvectorVersionAtLeast', () => {
  it.each([
    ['0.8.6', [0, 7, 0], true],
    ['0.7.0', [0, 7, 0], true],
    ['0.6.2', [0, 7, 0], false],
    ['1.0.0', [0, 8, 0], true],
    ['0.8', [0, 8, 0], true],
    ['0.10.1', [0, 8, 0], true],
    ['0.7.4-dev', [0, 8, 0], false],
  ] as const)('%s >= %p is %p', (v, min, expected) => {
    expect(pgvectorVersionAtLeast(v, min as unknown as [number, number, number])).toBe(expected);
  });

  it('an unreadable version is not assumed new enough', () => {
    expect(pgvectorVersionAtLeast('', [0, 7, 0])).toBe(false);
    expect(pgvectorVersionAtLeast('dev', [0, 7, 0])).toBe(false);
  });
});

describe('estimates (measured on the scale bench, 4 vCPU, pg16 / pgvector 0.8.6)', () => {
  it('index size: 288k chunks at 1536 dims measured 1125 MiB', () => {
    const mib = estimateHalfvecIndexBytes(288_000, 1536, 16) / 2 ** 20;
    expect(mib).toBeGreaterThan(1000);
    expect(mib).toBeLessThan(1300);
  });

  it('index size: 1.08M chunks at 384 dims measured 1208 MiB', () => {
    const mib = estimateHalfvecIndexBytes(1_080_000, 384, 16) / 2 ** 20;
    expect(mib).toBeGreaterThan(1000);
    expect(mib).toBeLessThan(1400);
  });

  it('no chunks: no pages', () => {
    expect(estimateHalfvecIndexBytes(0, 1536, 16)).toBe(0);
  });

  it('serial build time: 443 s at 288k x 1536 and 963 s at 1.08M x 384 (ef_construction 200)', () => {
    const a = estimateBuildSeconds(288_000, 1536, 200, false);
    const b = estimateBuildSeconds(1_080_000, 384, 200, false);
    expect(a).toBeGreaterThan(443 * 0.8);
    expect(a).toBeLessThan(443 * 1.2);
    expect(b).toBeGreaterThan(963 * 0.8);
    expect(b).toBeLessThan(963 * 1.2);
  });

  it('ef_construction 64 builds in about half the time; a parallel build (2 workers) about 2.9x faster', () => {
    const ef200 = estimateBuildSeconds(288_000, 1536, 200, false);
    expect(estimateBuildSeconds(288_000, 1536, 64, false) / ef200).toBeCloseTo(231 / 443, 1);
    expect(ef200 / estimateBuildSeconds(288_000, 1536, 200, true)).toBeCloseTo(443 / 155, 0);
  });
});

describe('the boot schema creates the new kind on a new install only', () => {
  const vectorIndexStatement = (n: number) => splitSqlStatements(buildSchemaSql(n))
    .filter((s) => s.includes('idx_chunks_hnsw'));

  it.each([8, 1536, 2000, 3072, 4000])('%i dims: one guarded statement with the halfvec definition', (n) => {
    const statements = vectorIndexStatement(n);
    expect(statements).toHaveLength(1);
    const [s] = statements;
    expect(s).toMatch(/^DO \$\$/);
    expect(s).toContain(halfvecIndexDefinition(n));
    // never over an existing index of that name, never over existing chunks
    expect(s).toMatch(/relname = 'idx_chunks_hnsw'/);
    expect(s).toMatch(/EXISTS \(SELECT 1 FROM vector_store_chunks\)/);
    expect(s).not.toMatch(/CONCURRENTLY/);
  });

  it('falls back to the previous plain-vector index on pgvector older than 0.7, where pgvector can index it', () => {
    expect(vectorIndexStatement(1536)[0]).toContain('USING hnsw (embedding vector_cosine_ops)');
    expect(vectorIndexStatement(3072)[0]).not.toContain('vector_cosine_ops)');
  });

  it('stays in the main phase', () => {
    const { main, post } = splitSchemaPhases(buildSchemaSql(1536));
    expect(main.some((s) => s.includes('idx_chunks_hnsw'))).toBe(true);
    expect(post.some((s) => s.includes('idx_chunks_hnsw'))).toBe(false);
  });
});

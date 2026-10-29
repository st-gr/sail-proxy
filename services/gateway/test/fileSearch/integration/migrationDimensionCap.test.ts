// W4 Task 1: the first-ever migration with a wide embedding setting. 3072 (above pgvector's 2000-dimension
// limit for a plain-vector HNSW index) migrates with the halfvec index (Task 2); 4001 is reported
// unavailable without a raw pgvector error.
import { Pool } from 'pg';
import { getPool, runMigration, isFileSearchAvailable, __resetForTests } from '../../../src/fileSearch/db';
import { createFreshDatabase, dsnForDatabase, FreshDatabase } from './dbFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

d('embedding dimension cap at migration (requires FILE_SEARCH_TEST_DSN)', () => {
  const fresh: FreshDatabase[] = [];
  const saved = process.env.FILE_SEARCH_DATABASE_URL;
  afterEach(async () => {
    await getPool()?.end().catch(() => {});
    __resetForTests();
  });
  afterAll(async () => {
    process.env.FILE_SEARCH_DATABASE_URL = saved;
    for (const f of fresh) await f.drop(); // eslint-disable-line no-await-in-loop
  });

  async function migrateWith(dims: number): Promise<{ ok: boolean; dsn: string }> {
    const db = await createFreshDatabase(DSN!, 'fs_dimcap_');
    fresh.push(db);
    const dsn = dsnForDatabase(DSN!, db.name);
    process.env.FILE_SEARCH_DATABASE_URL = dsn;
    delete process.env.FILE_SEARCH_MIGRATION_DATABASE_URL;
    mockConfig = { enabled: true, embeddingModel: 'm', embeddingDimensions: dims, limits: {}, hybrid: {} };
    __resetForTests();
    return { ok: await runMigration(), dsn };
  }

  it('3072 migrates with the halfvec HNSW index', async () => {
    const { ok, dsn } = await migrateWith(3072);
    expect(ok).toBe(true);
    expect(isFileSearchAvailable()).toBe(true);
    const p = new Pool({ connectionString: dsn });
    try {
      const { rows } = await p.query("SELECT indexdef FROM pg_indexes WHERE tablename = 'vector_store_chunks' AND indexname = 'idx_chunks_hnsw'");
      expect(rows).toHaveLength(1);
      expect(rows[0].indexdef).toContain('(((embedding)::halfvec(3072)) halfvec_cosine_ops)');
      const t = await p.query("SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'vector_store_chunks'::regclass AND attname = 'embedding'");
      expect(t.rows[0].t).toBe('vector(3072)');
    } finally { await p.end(); }
  });

  it('1536 still builds the HNSW index', async () => {
    const { ok, dsn } = await migrateWith(1536);
    expect(ok).toBe(true);
    const p = new Pool({ connectionString: dsn });
    try {
      const { rows } = await p.query("SELECT indexname FROM pg_indexes WHERE tablename = 'vector_store_chunks'");
      expect(rows.map((r) => r.indexname)).toContain('idx_chunks_hnsw');
    } finally { await p.end(); }
  });

  it('4001 is unavailable, creates nothing, and does not throw', async () => {
    const { ok, dsn } = await migrateWith(4001);
    expect(ok).toBe(false);
    expect(isFileSearchAvailable()).toBe(false);
    const p = new Pool({ connectionString: dsn });
    try {
      const { rows } = await p.query("SELECT to_regclass('file_blobs') IS NOT NULL AS e");
      expect(rows[0].e).toBe(false);
    } finally { await p.end(); }
  });
});

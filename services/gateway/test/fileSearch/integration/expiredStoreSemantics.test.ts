// Live-Postgres coverage of I4 (Task 12 review): the chosen semantics for
// an expired store are TERMINAL for use — it must permanently reject new
// attaches and searches, while remaining retrievable, listable and
// deletable, matching OpenAI's own "expired keeps its row" behaviour for
// those read paths. See repository.ts's StoreExpiredError/
// assertStoreNotExpired doc comments for why the alternative (treating
// activity as "reviving" an expired store) was rejected: status is never
// cleared off 'expired' anywhere in this codebase, so a revived store would
// never become sweepable again, and search touching last_active_at/
// expires_at on it would make its storage unbounded.
//
// Before this fix (verified live during review): attachFile was accepted
// on an already-expired store, chunks were written, and re-backdating
// expires_at yielded sweepExpiredStores() === 0 with the new chunk
// surviving indefinitely — storage past the deadline was unbounded.
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { sha256Of, retainBlob } from '../../../src/fileSearch/blob/blobStore';
import { newFileId } from '../../../src/fileSearch/ids';
import * as repo from '../../../src/fileSearch/repository';
import * as ctrl from '../../../src/controllers/vectorStoresController';
import { searchVectorStores } from '../../../src/fileSearch/search';
import { sweepExpiredStores } from '../../../src/fileSearch/expirySweeper';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

function makeRes(): any {
  const res: any = { headersSent: false, statusCode: 200 };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
}

function baseReq(email: string, overrides: Record<string, any> = {}): any {
  return { headers: {}, params: {}, query: {}, body: {}, apiKeyInfo: { email }, ...overrides };
}

const throwOnError = (e: any) => { throw e; };

d('expired-store semantics against a real Postgres database (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  beforeAll(async () => {
    mockConfig = {
      enabled: true,
      embeddingModel: 'test-model',
      embeddingDimensions: EMBED_DIM,
      rewriteQuery: false,
      hybrid: { rrfK: 60, lexicalEnabled: true, candidates: 50, rerank: { enabled: false, model: 'unused' } },
      limits: { maxFilesPerStore: 10000 },
      blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
    };
    fixture = await createIsolatedSchema(DSN!, EMBED_DIM);
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    __resetForTests();
    await runMigration();
    pool = getPool()!;
  });

  afterAll(async () => {
    // The env var is cleared before the first `await`, matching
    // storeAccessGuard.test.ts. Consistency only, not a fix: Jest gives each
    // worker its own process and runs files sequentially within one, so this
    // could not leak across files in either order -- but tearing the two
    // suites down identically means a reader never has to work out whether
    // the difference was deliberate.
    __resetForTests();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await pool.end();
    await fixture.teardown();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM vector_store_chunks');
    await pool.query('DELETE FROM vector_store_files');
    await pool.query('DELETE FROM vector_stores');
    await pool.query('DELETE FROM fs_files');
    await pool.query('DELETE FROM file_blobs');
  });

  async function seedFile(ownerEmail: string, filename: string, content: Buffer): Promise<{ id: string }> {
    const sha = sha256Of(content);
    await retainBlob(sha, content, 'text/plain');
    const id = newFileId();
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
       VALUES ($1,$2,$3,'assistants',$4,$5, now())`,
      [id, ownerEmail, filename, sha, content.length],
    );
    return { id };
  }

  async function seedChunk(storeId: string, fileId: string, ord: number, text: string): Promise<void> {
    const embedding = `[${Array.from({ length: EMBED_DIM }, () => Math.random()).join(',')}]`;
    await pool.query(
      `INSERT INTO vector_store_chunks (store_id, file_id, ord, text, embedding) VALUES ($1,$2,$3,$4,$5::vector)`,
      [storeId, fileId, ord, text, embedding],
    );
  }

  async function makeExpiredStore(owner: string): Promise<{ id: string }> {
    const store = await repo.createStore({ ownerEmail: owner, name: 's', expiresAfter: { anchor: 'last_active_at', days: 1 } });
    await pool.query(`UPDATE vector_stores SET expires_at = now() - interval '1 minute' WHERE id = $1`, [store.id]);
    const swept = await sweepExpiredStores();
    expect(swept).toBe(1);
    const { rows } = await pool.query('SELECT status FROM vector_stores WHERE id=$1', [store.id]);
    expect(rows[0].status).toBe('expired');
    return store;
  }

  it('attachFile via the controller 409s on an expired store and creates no attachment or chunks', async () => {
    const owner = 'expired-attach@example.com';
    const store = await makeExpiredStore(owner);
    const file = await seedFile(owner, 'f.txt', Buffer.from('x'));

    const res = makeRes();
    await ctrl.createVectorStoreFile(
      baseReq(owner, { params: { id: store.id }, body: { file_id: file.id } }), res, throwOnError,
    );
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('vector_store_expired');

    const { rows } = await pool.query('SELECT 1 FROM vector_store_files WHERE store_id=$1 AND file_id=$2', [store.id, file.id]);
    expect(rows).toHaveLength(0); // never attached — the bug this closes let this row exist
  });

  it("re-backdating an already-expired store's expires_at does not resurrect it via the sweeper, and a manually-inserted chunk cannot survive indefinitely because attach itself is blocked", async () => {
    const owner = 'expired-resweep@example.com';
    const store = await makeExpiredStore(owner);

    // The exact bug reported live: re-backdating expires_at on an already-
    // 'expired' store and sweeping again.
    await pool.query(`UPDATE vector_stores SET expires_at = now() - interval '1 minute' WHERE id = $1`, [store.id]);
    const swept = await sweepExpiredStores();
    expect(swept).toBe(0); // status != 'expired' guard — already handled, not re-processed

    // And the attach path that would have let new chunks accumulate on it
    // is blocked (see the test above) — status stays 'expired' forever,
    // never becoming a live target for new data.
    const { rows } = await pool.query('SELECT status FROM vector_stores WHERE id=$1', [store.id]);
    expect(rows[0].status).toBe('expired');
  });

  it('searchVectorStores 409s on an expired store and does NOT touch last_active_at/expires_at (no unbounded sliding)', async () => {
    const owner = 'expired-search@example.com';
    const file = await seedFile(owner, 'f.txt', Buffer.from('x'));
    const store = await repo.createStore({ ownerEmail: owner, name: 's', expiresAfter: { anchor: 'last_active_at', days: 1 } });
    await repo.attachFile(store.id, file.id, {});
    await seedChunk(store.id, file.id, 0, 'some searchable text');
    await pool.query(`UPDATE vector_stores SET expires_at = now() - interval '1 minute' WHERE id = $1`, [store.id]);
    expect(await sweepExpiredStores()).toBe(1);

    const before = await pool.query('SELECT last_active_at, expires_at FROM vector_stores WHERE id=$1', [store.id]);

    await expect(searchVectorStores({ storeIds: [store.id], query: 'some searchable text', ownerEmail: owner }))
      .rejects.toMatchObject({ status: 409 });

    const after = await pool.query('SELECT last_active_at, expires_at, status FROM vector_stores WHERE id=$1', [store.id]);
    expect(after.rows[0].status).toBe('expired');
    // Byte-identical timestamps — proves touchStoreActivity never ran.
    expect(after.rows[0].last_active_at.getTime()).toBe(before.rows[0].last_active_at.getTime());
    expect(after.rows[0].expires_at.getTime()).toBe(before.rows[0].expires_at.getTime());
  });

  it('the HTTP search endpoint 409s for an expired store with the vector_store_expired code', async () => {
    const owner = 'expired-search-http@example.com';
    const store = await makeExpiredStore(owner);

    const res = makeRes();
    await ctrl.searchVectorStore(baseReq(owner, { params: { id: store.id }, body: { query: 'anything' } }), res, throwOnError);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('vector_store_expired');
  });

  it('an expired store remains retrievable, listable and deletable — only attach and search are blocked', async () => {
    const owner = 'expired-still-visible@example.com';
    const store = await makeExpiredStore(owner);

    const getRes = makeRes();
    await ctrl.retrieveVectorStore(baseReq(owner, { params: { id: store.id } }), getRes, throwOnError);
    expect(getRes.statusCode).toBe(200);
    expect(getRes.body.status).toBe('expired');

    const listRes = makeRes();
    await ctrl.listVectorStores(baseReq(owner), listRes, throwOnError);
    expect(listRes.body.data.map((s: any) => s.id)).toContain(store.id);

    const deleteRes = makeRes();
    await ctrl.deleteVectorStore(baseReq(owner, { params: { id: store.id } }), deleteRes, throwOnError);
    expect(deleteRes.statusCode).toBe(200);

    const { rows } = await pool.query('SELECT 1 FROM vector_stores WHERE id=$1', [store.id]);
    expect(rows).toHaveLength(0); // genuinely deletable
  });
});

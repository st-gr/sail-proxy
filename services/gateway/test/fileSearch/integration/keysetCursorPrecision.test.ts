// The keyset cursor must not lose precision on its round trip through Node.
//
// All three list endpoints resolve `after`/`before` by reading the cursor row's
// `created_at`, then re-binding it in `(created_at, id) > (cursor_created_at,
// cursor_id)`. Read as a JS Date that value is truncated to MILLISECONDS, while
// Postgres stores `timestamptz` to MICROSECONDS — so the rebound cursor is
// marginally EARLIER than the row it names, the comparison matches that row,
// and every page repeats its own first row.
//
// The defect was latent for as long as these columns were written from a JS
// Date and so had nothing below the millisecond to lose. It became reachable
// the moment they started coming from Postgres `now()`. It is pinned here
// rather than left to the one batch test that happened to catch it, because
// two of the three endpoints below were silently broken by that change and no
// test failed.
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { sha256Of, retainBlob } from '../../../src/fileSearch/blob/blobStore';
import { newFileId } from '../../../src/fileSearch/ids';
import * as repo from '../../../src/fileSearch/repository';
import { listBatchFiles, createBatch } from '../../../src/fileSearch/batches';
import * as storesCtrl from '../../../src/controllers/vectorStoresController';
import * as filesCtrl from '../../../src/controllers/filesController';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const OWNER = 'cursor@example.com';

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

function baseReq(overrides: Record<string, any> = {}): any {
  return { headers: {}, params: {}, query: {}, body: {}, apiKeyInfo: { email: OWNER }, ...overrides };
}

const throwOnError = (e: any) => { throw e; };

d('keyset cursor precision (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  beforeAll(async () => {
    mockConfig = {
      enabled: true,
      embeddingModel: 'test-model',
      embeddingDimensions: EMBED_DIM,
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
    __resetForTests();
    await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM vector_store_files');
    await pool.query('DELETE FROM vector_store_batches');
    await pool.query('DELETE FROM vector_stores');
    await pool.query('DELETE FROM fs_files');
    await pool.query('DELETE FROM file_blobs');
  });

  /**
   * Forces the exact condition under test: a `created_at` carrying microseconds
   * that no JS Date can represent. Spacing the rows a whole second apart keeps
   * their ORDER unambiguous, so a repeated row can only come from the cursor
   * comparison and never from a tie.
   */
  async function stampWithMicroseconds(table: string, idColumn: string, ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `UPDATE ${table} SET created_at = date_trunc('second', now())
           + make_interval(secs => $2::int) + interval '456 microseconds'
         WHERE ${idColumn} = $1`,
        [ids[i], i],
      );
    }
  }

  async function seedFile(filename: string): Promise<string> {
    const content = Buffer.from(filename);
    const sha = sha256Of(content);
    await retainBlob(sha, content, 'text/plain');
    const id = newFileId();
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
       VALUES ($1,$2,$3,'assistants',$4,$5, now())`,
      [id, OWNER, filename, sha, content.length],
    );
    return id;
  }

  it('does not repeat the cursor row when listing vector stores', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      ids.push((await repo.createStore({ ownerEmail: OWNER, name: `s${i}` })).id);
    }
    await stampWithMicroseconds('vector_stores', 'id', ids);

    const res = makeRes();
    await storesCtrl.listVectorStores(
      baseReq({ query: { order: 'asc', after: ids[0], limit: '10' } }), res, throwOnError);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.map((s: any) => s.id)).toEqual([ids[1], ids[2]]);
  });

  it('does not repeat the cursor row when listing files', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push(await seedFile(`f${i}.txt`));
    await stampWithMicroseconds('fs_files', 'id', ids);

    const res = makeRes();
    await filesCtrl.listFiles(
      baseReq({ query: { order: 'asc', after: ids[0], limit: '10' } }), res, throwOnError);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.map((f: any) => f.id)).toEqual([ids[1], ids[2]]);
  });

  it('does not repeat the cursor row when listing a batch\'s files', async () => {
    const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push(await seedFile(`b${i}.txt`));
    const batch = await createBatch(store.id, ids, null, null);
    await stampWithMicroseconds('vector_store_files', 'file_id', ids);

    const page = await listBatchFiles(store.id, batch.id, { limit: 10, order: 'asc', after: ids[0] });
    expect(page.map((r) => r.file_id)).toEqual([ids[1], ids[2]]);
  });
});

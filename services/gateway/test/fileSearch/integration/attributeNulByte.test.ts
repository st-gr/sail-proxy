/**
 * FINAL WHOLE-BRANCH REVIEW, CRITICAL #2 — the real-Postgres half.
 *
 * `test/fileSearch/attributeNulByte.test.ts` pins that all four entry points answer 400.
 * What a mocked pool CANNOT show is the thing the fix exists for: that the payload, if it
 * got through, is a 500 and not merely a different 400. That claim is about Postgres, so
 * it is asserted against Postgres here.
 *
 * The disproved comment: "JSON.stringify escapes an embedded NUL byte to a six-character
 * escape sequence, which is why those two are safe without this check". `stringify` does
 * produce the escape; `jsonb` then rejects that escape SPECIFICALLY, because jsonb stores
 * decoded text and U+0000 has no representation in it.
 *
 * @see ../../../src/fileSearch/repository.ts - validateAttributes
 * @see ../attributeNulByte.test.ts - the same guard at all four HTTP entry points
 */
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import * as ctrl from '../../../src/controllers/vectorStoresController';
import * as repo from '../../../src/fileSearch/repository';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

/** Built via fromCharCode, so no raw NUL byte lives in this source file. */
const NUL = String.fromCharCode(0);

function makeRes(): any {
  const res: any = { headersSent: false, statusCode: 200 };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  res.set = () => res;
  res.send = (body: any) => { res.body = body; return res; };
  return res;
}

const baseReq = (email: string, overrides: Record<string, any> = {}): any =>
  ({ headers: {}, params: {}, query: {}, body: {}, apiKeyInfo: { email }, ...overrides });

d('a NUL byte in attributes against a real Postgres (requires FILE_SEARCH_TEST_DSN)', () => {
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
    await pool.query('DELETE FROM vector_stores');
  });

  it('THE DISPROVED CLAIM: JSON.stringify does not make a NUL safe — jsonb rejects 22P05', async () => {
    // This is the whole finding, reduced to two lines and run against the real engine.
    const stringified = JSON.stringify({ dept: `leg${NUL}al` });
    expect(stringified).toContain('\\u0000');           // the escape the comment relied on

    await expect(pool.query('SELECT $1::jsonb AS j', [stringified])).rejects.toMatchObject({
      code: '22P05',                                     // unsupported Unicode escape sequence
    });

    // ...and it carries no `status`, which is precisely why `handleKnownError` cannot map
    // it and the caller used to receive a 500.
    try {
      await pool.query('SELECT $1::jsonb AS j', [stringified]);
      throw new Error('expected jsonb to reject the escape');
    } catch (err: any) {
      expect(err.status).toBeUndefined();
    }
  });

  it('createVectorStore answers 400 and writes NO row — the guard runs before the INSERT', async () => {
    const res = makeRes();
    const next = jest.fn();

    await ctrl.createVectorStore(
      baseReq('owner@x.com', { body: { name: 'n', metadata: { dept: `leg${NUL}al` } } }), res, next as any);

    // ASSERTED FIRST, deliberately. `next(err)` IS the 500 — the controller writes no
    // status of its own and Express's error middleware answers. Verified by mutation:
    // delete the guard in `validateAttributes` and this line fails with
    //   next called once, err.code = 22P05, err.status = undefined
    // which is the original defect exactly. Asserting the status first would report the
    // same run as "expected 400, received 200" and hide what happened.
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('invalid_attributes');

    const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM vector_stores');
    expect(rows[0].c).toBe(0);
  });

  it('modifyVectorStoreFile answers 400 and leaves the stored attributes untouched', async () => {
    const store = await repo.createStore({ ownerEmail: 'owner@x.com', name: 's' });
    const sha = 'a'.repeat(64);
    await pool.query(
      `INSERT INTO file_blobs (sha256, size_bytes, mime, ref_count, storage, bytes, created_at)
       VALUES ($1, 5, 'text/plain', 1, 'db', $2, now())`, [sha, Buffer.from('hello')]);
    const fileId = 'file-bbbbbbbbbbbbbbbbbbbbbbbb';
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
       VALUES ($1, 'owner@x.com', 'f.txt', 'assistants', $2, 5, now())`, [fileId, sha]);
    await repo.attachFile(store.id, fileId, { dept: 'legal' });

    const res = makeRes();
    const next = jest.fn();
    await ctrl.modifyVectorStoreFile(
      baseReq('owner@x.com', {
        params: { id: store.id, file_id: fileId },
        body: { attributes: { dept: `leg${NUL}al` } },
      }), res, next as any);

    expect(next).not.toHaveBeenCalled();                 // same reasoning as above
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('invalid_attributes');

    const { rows } = await pool.query(
      'SELECT attributes FROM vector_store_files WHERE store_id=$1 AND file_id=$2', [store.id, fileId]);
    expect(rows[0].attributes).toEqual({ dept: 'legal' });   // the original survives
  });

  it('a NUL-free payload still round-trips through jsonb, so the guard is not over-broad', async () => {
    const res = makeRes();
    await ctrl.createVectorStore(
      baseReq('owner@x.com', { body: { name: 'n', metadata: { dept: 'legal', year: 2026, ok: true } } }),
      res, jest.fn() as any);

    expect(res.statusCode).toBe(200);
    const { rows } = await pool.query('SELECT metadata FROM vector_stores');
    expect(rows[0].metadata).toEqual({ dept: 'legal', year: 2026, ok: true });
  });
});

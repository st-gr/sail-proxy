// File expiry (G11) against a real Postgres database: an upload with OpenAI's
// `expires_after {anchor: "created_at", seconds}` stores `fs_files.expires_at` from the database
// clock; until the sweeper runs, an expired file is already gone for GET, list, download and
// search; the sweeper then deletes it exactly as a user DELETE /files/{id} does (detached from
// the owner's stores, chunks gone, blob released) and leaves files that never expire or have not
// expired yet. Two sweepers, or a sweeper and a user delete, racing for one file release its blob
// exactly once (60 iterations each).
import * as crypto from 'crypto';
import { Readable } from 'stream';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { sha256Of, retainBlob } from '../../../src/fileSearch/blob/blobStore';
import { newFileId } from '../../../src/fileSearch/ids';
import * as repo from '../../../src/fileSearch/repository';
import * as filesController from '../../../src/controllers/filesController';
import * as storesController from '../../../src/controllers/vectorStoresController';
import * as admin from '../../../src/fileSearch/admin';
import { storageOfOwner, listAttachmentsForFiles } from '../../../src/fileSearch/groundingQueries';
import {
  sweepExpiredFiles, startExpirySweeper, stopExpirySweeper, __resetFileSweepForTests,
} from '../../../src/fileSearch/expirySweeper';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const OWNER = 'expiry-owner@example.com';
const RACE_ITERATIONS = 60;

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

function makeRes(): any {
  const res: any = { headersSent: false, statusCode: 200 };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  res.set = () => res;
  res.send = (body: any) => { res.body = body; return res; };
  return res;
}

const baseReq = (overrides: Record<string, any> = {}): any => (
  { headers: {}, params: {}, query: {}, body: {}, apiKeyInfo: { email: OWNER }, ...overrides });
const throwOnError = (e: any) => { throw e; };

/** A handler's answer with `id` written as <id>, so two answers for different ids compare. */
const answer = (res: any, id: string): unknown => ({
  status: res.statusCode, body: JSON.parse(JSON.stringify(res.body ?? null).split(id).join('<id>')),
});

function uploadReq(content: Buffer, fields: Array<[string, string]>): any {
  const boundary = `b${crypto.randomBytes(8).toString('hex')}`;
  const parts: Buffer[] = [Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="doc.txt"\r\nContent-Type: text/plain\r\n\r\n`, 'latin1'),
  content, Buffer.from('\r\n', 'latin1')];
  for (const [name, value] of fields) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'latin1'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'latin1'));
  const req: any = new Readable({ read() {} });
  Object.assign(req, baseReq({ headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, method: 'POST' }));
  req.push(Buffer.concat(parts));
  req.push(null);
  return req;
}

d('file expiry against a real Postgres database (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  beforeAll(async () => {
    mockConfig = {
      enabled: true,
      embeddingModel: 'test-model',
      embeddingDimensions: EMBED_DIM,
      limits: { maxFilesPerStore: 10000, maxFileBytes: 1024 * 1024 },
      blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
      hybrid: { rrfK: 60, lexicalEnabled: true, lexicalQuery: 'any', candidates: 50 },
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
    __resetFileSweepForTests();
    await pool.query('DELETE FROM vector_store_chunks');
    await pool.query('DELETE FROM vector_store_files');
    await pool.query('DELETE FROM vector_stores');
    await pool.query('DELETE FROM fs_files');
    await pool.query('DELETE FROM file_blobs');
  });

  /** A file row for `content`; `expiresInMs` null never expires, negative is already expired. */
  async function seedFile(content: Buffer, expiresInMs: number | null): Promise<{ id: string; sha: string }> {
    const sha = sha256Of(content);
    await retainBlob(sha, content, 'text/plain');
    const id = newFileId();
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at, expires_at)
       VALUES ($1, $2, 'doc.txt', 'assistants', $3, $4, now(),
               CASE WHEN $5::float8 IS NULL THEN NULL ELSE now() + ($5::float8 * interval '1 millisecond') END)`,
      [id, OWNER, sha, content.length, expiresInMs],
    );
    return { id, sha };
  }

  async function seedChunk(storeId: string, fileId: string, text: string): Promise<void> {
    await pool.query(
      `INSERT INTO vector_store_chunks (store_id, file_id, ord, text, embedding) VALUES ($1, $2, 0, $3, '[0.1,0.2,0.3]'::vector)`,
      [storeId, fileId, text],
    );
  }

  async function attachWithChunk(fileId: string, text = 'expiring passage'): Promise<string> {
    const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
    await repo.attachFile(store.id, fileId, {});
    await pool.query(`UPDATE vector_store_files SET status = 'completed' WHERE store_id = $1`, [store.id]);
    await seedChunk(store.id, fileId, text);
    return store.id;
  }

  const count = async (sql: string, params: any[]): Promise<number> => Number((await pool.query(sql, params)).rows[0].n);
  const refCount = async (sha: string): Promise<number> =>
    (await pool.query('SELECT ref_count FROM file_blobs WHERE sha256 = $1', [sha])).rows[0].ref_count;

  it('an upload with expires_after stores expires_at = created_at + seconds and returns it', async () => {
    const res = makeRes();
    await filesController.uploadFile(
      uploadReq(Buffer.from('expiring upload'), [['purpose', 'assistants'], ['expires_after[anchor]', 'created_at'], ['expires_after[seconds]', '3600']]),
      res, (e: any) => { throw e; });
    expect(res.statusCode).toBe(200);
    expect(res.body.expires_at - res.body.created_at).toBe(3600);
    const { rows } = await pool.query(
      'SELECT extract(epoch FROM expires_at - created_at)::int AS secs FROM fs_files WHERE id = $1', [res.body.id]);
    expect(rows[0].secs).toBe(3600);

    const plain = makeRes();
    await filesController.uploadFile(uploadReq(Buffer.from('forever'), [['purpose', 'assistants']]), plain, (e: any) => { throw e; });
    expect(plain.body).not.toHaveProperty('expires_at');
    expect((await pool.query('SELECT expires_at FROM fs_files WHERE id = $1', [plain.body.id])).rows[0].expires_at).toBeNull();
  });

  it('before the sweep, an expired file is gone for GET, list, download and search', async () => {
    const expired = await seedFile(Buffer.from('expired content'), -1000);
    const live = await seedFile(Buffer.from('live content'), null);
    const storeId = await attachWithChunk(expired.id, 'alpha expired passage');
    await pool.query(`INSERT INTO vector_store_files (store_id, file_id, status) VALUES ($1, $2, 'completed')`, [storeId, live.id]);
    await seedChunk(storeId, live.id, 'alpha live passage');

    const getRes = makeRes();
    await filesController.retrieveFile(baseReq({ params: { id: expired.id } }), getRes, (e: any) => { throw e; });
    expect(getRes.statusCode).toBe(404);

    const listRes = makeRes();
    await filesController.listFiles(baseReq(), listRes, (e: any) => { throw e; });
    expect(listRes.body.data.map((f: any) => f.id)).toEqual([live.id]);

    const dlRes = makeRes();
    await filesController.downloadFileContent(baseReq({ params: { id: expired.id } }), dlRes, (e: any) => { throw e; });
    expect(dlRes.statusCode).toBe(404);

    const hits = await repo.recallCandidates({
      storeIds: [storeId], ownerEmail: OWNER, queryText: 'alpha', limit: 10, queryEmbedding: [0.1, 0.2, 0.3],
    });
    const fileIds = new Set(hits.map((h) => h.fileId));
    expect(fileIds.has(expired.id)).toBe(false);
    expect(fileIds.has(live.id)).toBe(true);
  });

  it('the sweeper deletes an expired file like a user delete and leaves the others', async () => {
    const shared = Buffer.from('content shared by an expiring and a permanent file');
    const expired = await seedFile(shared, -1000);
    const permanent = await seedFile(shared, null);
    const later = await seedFile(Buffer.from('expires tomorrow'), 86_400_000);
    const storeA = await attachWithChunk(expired.id);
    const storeB = await attachWithChunk(expired.id);
    const storeLater = await attachWithChunk(later.id);
    expect(await refCount(expired.sha)).toBe(2);

    expect(await sweepExpiredFiles()).toBe(1);

    expect(await count('SELECT count(*) AS n FROM fs_files WHERE id = $1', [expired.id])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM vector_store_files WHERE file_id = $1', [expired.id])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM vector_store_chunks WHERE file_id = $1', [expired.id])).toBe(0);
    // The stores stay (a user delete detaches the file, it does not delete stores).
    expect(await count('SELECT count(*) AS n FROM vector_stores WHERE id = ANY($1)', [[storeA, storeB]])).toBe(2);
    // Released once: the permanent file still holds the shared blob.
    expect(await refCount(expired.sha)).toBe(1);
    // The storage per owner the cockpit shows is derived from fs_files, so it drops with the row.
    expect(await count('SELECT count(*) AS n FROM fs_files WHERE owner_email = $1', [OWNER])).toBe(2);

    expect(await count('SELECT count(*) AS n FROM fs_files WHERE id = ANY($1)', [[permanent.id, later.id]])).toBe(2);
    expect(await count('SELECT count(*) AS n FROM vector_store_chunks WHERE store_id = $1', [storeLater])).toBe(1);

    expect(await sweepExpiredFiles()).toBe(0);
  });

  it('an expiry delete leaves the stores\' activity alone; a user delete still refreshes it', async () => {
    const expired = await seedFile(Buffer.from('expires while the store idles'), -1000);
    const live = await seedFile(Buffer.from('deleted by its owner'), null);
    const idleStore = await attachWithChunk(expired.id);
    const usedStore = await attachWithChunk(live.id);
    // Both stores expire 7 days after their last activity, which was 3 days ago.
    await pool.query(
      `UPDATE vector_stores SET expires_after = '{"anchor":"last_active_at","days":7}'::jsonb,
              last_active_at = now() - interval '3 days', expires_at = now() + interval '4 days'
        WHERE id = ANY($1)`, [[idleStore, usedStore]]);
    const activity = async (id: string) => (await pool.query(
      `SELECT last_active_at::text AS last_active_at, expires_at::text AS expires_at FROM vector_stores WHERE id = $1`, [id])).rows[0];
    const idleBefore = await activity(idleStore);
    const usedBefore = await activity(usedStore);

    expect(await sweepExpiredFiles()).toBe(1);
    expect(await count('SELECT count(*) AS n FROM vector_store_files WHERE store_id = $1', [idleStore])).toBe(0);
    expect(await activity(idleStore)).toEqual(idleBefore);

    expect(await repo.deleteFileDetachingEverywhere(live.id, OWNER)).toMatchObject({ deleted: true });
    const usedAfter = await activity(usedStore);
    expect(usedAfter.last_active_at > usedBefore.last_active_at).toBe(true);
    expect(usedAfter.expires_at > usedBefore.expires_at).toBe(true);
  });

  it('a released last reference leaves the blob pending deletion for the blob sweeper', async () => {
    const only = await seedFile(Buffer.from('only reference'), -1000);
    expect(await sweepExpiredFiles()).toBe(1);
    const { rows } = await pool.query('SELECT ref_count, delete_after FROM file_blobs WHERE sha256 = $1', [only.sha]);
    expect(rows[0].ref_count).toBe(0);
    expect(rows[0].delete_after).not.toBeNull();
  });

  it(`two sweepers racing for one file delete it once and release its blob once (${RACE_ITERATIONS} iterations)`, async () => {
    for (let i = 0; i < RACE_ITERATIONS; i += 1) {
      const content = Buffer.from(`race content ${i}`);
      /* eslint-disable no-await-in-loop */
      const keeper = await seedFile(content, null);
      const doomed = await seedFile(content, -1000);
      await attachWithChunk(doomed.id);
      const swept = await Promise.all([sweepExpiredFiles(), sweepExpiredFiles()]);
      expect(swept[0] + swept[1]).toBe(1);
      expect(await refCount(doomed.sha)).toBe(1);
      expect(await count('SELECT count(*) AS n FROM fs_files WHERE id = $1', [doomed.id])).toBe(0);
      expect(await count('SELECT count(*) AS n FROM fs_files WHERE id = $1', [keeper.id])).toBe(1);
      expect(await count('SELECT count(*) AS n FROM vector_store_chunks WHERE file_id = $1', [doomed.id])).toBe(0);
      /* eslint-enable no-await-in-loop */
    }
  }, 120_000);

  it(`a user delete racing the sweeper deletes the file once and releases its blob once (${RACE_ITERATIONS} iterations)`, async () => {
    for (let i = 0; i < RACE_ITERATIONS; i += 1) {
      const content = Buffer.from(`user race content ${i}`);
      /* eslint-disable no-await-in-loop */
      await seedFile(content, null);
      const doomed = await seedFile(content, -1000);
      await attachWithChunk(doomed.id);
      const [swept, userDelete] = await Promise.all([
        sweepExpiredFiles(), repo.deleteFileDetachingEverywhere(doomed.id, OWNER),
      ]);
      expect(swept + (userDelete.deleted ? 1 : 0)).toBe(1);
      expect(await refCount(doomed.sha)).toBe(1);
      expect(await count('SELECT count(*) AS n FROM fs_files WHERE id = $1', [doomed.id])).toBe(0);
      /* eslint-enable no-await-in-loop */
    }
  }, 120_000);

  it('the periodic sweep tick runs the file pass too', async () => {
    const doomed = await seedFile(Buffer.from('swept by the timer tick'), -1000);
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    startExpirySweeper();
    try {
      const tick = setIntervalSpy.mock.calls[0][0] as () => void;
      tick();
      for (let i = 0; i < 100; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        if (await count('SELECT count(*) AS n FROM fs_files WHERE id = $1', [doomed.id]) === 0) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(await count('SELECT count(*) AS n FROM fs_files WHERE id = $1', [doomed.id])).toBe(0);
    } finally {
      stopExpirySweeper();
    }
  });


  it('before the sweep, an expired file is gone from its vector stores: file list, retrieve and content', async () => {
    const expired = await seedFile(Buffer.from('expired store content'), -1000);
    const live = await seedFile(Buffer.from('live store content'), null);
    const storeId = await attachWithChunk(expired.id, 'expired text');
    await pool.query(`INSERT INTO vector_store_files (store_id, file_id, status) VALUES ($1, $2, 'completed')`, [storeId, live.id]);

    const listRes = makeRes();
    await storesController.listVectorStoreFiles(baseReq({ params: { id: storeId } }), listRes, throwOnError);
    expect(listRes.statusCode).toBe(200);
    expect(listRes.body.data.map((f: any) => f.id)).toEqual([live.id]);

    const missing = newFileId();
    for (const handler of [storesController.retrieveVectorStoreFile, storesController.downloadVectorStoreFileContent]) {
      const expiredRes = makeRes();
      // eslint-disable-next-line no-await-in-loop
      await handler(baseReq({ params: { id: storeId, file_id: expired.id } }), expiredRes, throwOnError);
      const missingRes = makeRes();
      // eslint-disable-next-line no-await-in-loop
      await handler(baseReq({ params: { id: storeId, file_id: missing } }), missingRes, throwOnError);
      expect(expiredRes.statusCode).toBe(404);
      expect(answer(expiredRes, expired.id)).toEqual(answer(missingRes, missing));
    }
  });

  it('attaching an expired file is answered exactly like attaching a file that does not exist', async () => {
    const expired = await seedFile(Buffer.from('expired, not attachable'), -1000);
    const missing = newFileId();
    const store = await repo.createStore({ ownerEmail: OWNER, name: 'attach target' });

    const attach = async (fileId: string): Promise<any> => {
      const res = makeRes();
      await storesController.createVectorStoreFile(baseReq({ params: { id: store.id }, body: { file_id: fileId } }), res, throwOnError);
      return res;
    };
    const batch = async (fileId: string): Promise<any> => {
      const res = makeRes();
      await storesController.createVectorStoreFileBatch(baseReq({ params: { id: store.id }, body: { file_ids: [fileId] } }), res, throwOnError);
      return res;
    };
    const create = async (fileId: string): Promise<any> => {
      const res = makeRes();
      await storesController.createVectorStore(baseReq({ body: { name: 'with files', file_ids: [fileId] } }), res, throwOnError);
      return res;
    };
    for (const call of [attach, batch, create]) {
      /* eslint-disable no-await-in-loop */
      const expiredRes = await call(expired.id);
      const missingRes = await call(missing);
      /* eslint-enable no-await-in-loop */
      expect(expiredRes.statusCode).toBeGreaterThanOrEqual(400);
      expect(answer(expiredRes, expired.id)).toEqual(answer(missingRes, missing));
    }
    expect(await count('SELECT count(*) AS n FROM vector_store_files WHERE file_id = $1', [expired.id])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM vector_stores WHERE owner_email = $1', [OWNER])).toBe(1);
  });

  it('DELETE /files/{id} of an expired file is the same 404 as GET; the sweeper still removes it', async () => {
    const expired = await seedFile(Buffer.from('expired, owner deletes'), -1000);
    await attachWithChunk(expired.id);
    const deleteRes = makeRes();
    await filesController.deleteFile(baseReq({ params: { id: expired.id } }), deleteRes, throwOnError);
    const getRes = makeRes();
    await filesController.retrieveFile(baseReq({ params: { id: expired.id } }), getRes, throwOnError);
    expect(deleteRes.statusCode).toBe(404);
    expect(answer(deleteRes, expired.id)).toEqual(answer(getRes, expired.id));
    expect(await count('SELECT count(*) AS n FROM fs_files WHERE id = $1', [expired.id])).toBe(1);

    expect(await sweepExpiredFiles()).toBe(1);
    expect(await count('SELECT count(*) AS n FROM fs_files WHERE id = $1', [expired.id])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM vector_store_chunks WHERE file_id = $1', [expired.id])).toBe(0);
  });

  it('files the sweep cannot delete do not starve the rest: the next pass resumes after them', async () => {
    // Stuck: still referenced by another owner's store (inUse), oldest deadlines first.
    const other = await repo.createStore({ ownerEmail: 'other-owner@example.com', name: 'foreign' });
    const stuck: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      /* eslint-disable no-await-in-loop */
      const file = await seedFile(Buffer.from(`stuck ${i}`), -100_000 + i);
      await pool.query(`INSERT INTO vector_store_files (store_id, file_id, status) VALUES ($1, $2, 'completed')`, [other.id, file.id]);
      /* eslint-enable no-await-in-loop */
      stuck.push(file.id);
    }
    const deletable = await seedFile(Buffer.from('deletable after the stuck ones'), -1000);

    const LIMIT = 3;
    expect(await sweepExpiredFiles(LIMIT)).toBe(0); // the first three stuck files
    expect(await sweepExpiredFiles(LIMIT)).toBe(1); // resumes: the fourth stuck file, then the deletable one
    expect(await count('SELECT count(*) AS n FROM fs_files WHERE id = $1', [deletable.id])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM fs_files WHERE id = ANY($1)', [stuck])).toBe(4);
    // A short batch reached the end: the next pass starts at the oldest deadline again.
    expect(await sweepExpiredFiles(LIMIT)).toBe(0);
  });

  it('a failing store pass does not stop the file pass of the same tick', async () => {
    const doomed = await seedFile(Buffer.from('swept although the store pass fails'), -1000);
    const realQuery = pool.query.bind(pool);
    // Assigned, not jest.spyOn: the gateway's jest config restores spies before every test.
    (pool as any).query = (sql: any, ...rest: any[]) => {
      if (typeof sql === 'string' && sql.includes('FROM vector_stores WHERE expires_at < now()')) {
        return Promise.reject(new Error('store pass failure'));
      }
      return (realQuery as any)(sql, ...rest);
    };
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    startExpirySweeper();
    try {
      (setIntervalSpy.mock.calls[0][0] as () => void)();
      for (let i = 0; i < 100; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        if (Number((await realQuery('SELECT count(*) AS n FROM fs_files WHERE id = $1', [doomed.id])).rows[0].n) === 0) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(Number((await realQuery('SELECT count(*) AS n FROM fs_files WHERE id = $1', [doomed.id])).rows[0].n)).toBe(0);
    } finally {
      stopExpirySweeper();
      (pool as any).query = realQuery;
    }
  });

  it('the admin and cockpit file queries run on the migrated schema (an unswept expired file still counts)', async () => {
    const expired = await seedFile(Buffer.from('admin sees until the sweep'), -1000);
    const live = await seedFile(Buffer.from('admin sees always'), null);
    const storeId = await attachWithChunk(live.id);

    const files = await admin.listAllFiles({ owner: OWNER, limit: 10 });
    expect(files.map((f) => f.id).sort()).toEqual([expired.id, live.id].sort());
    expect(Object.keys(files[0]).sort()).toEqual(
      ['attachment_count', 'created_at', 'filename', 'id', 'owner_email', 'purpose', 'size_bytes']);
    const byOwner = await admin.storageByOwner({ limit: 10 });
    expect(byOwner).toEqual([expect.objectContaining({ owner_email: OWNER, file_count: 2 })]);
    const overview = await admin.overview({ embeddingModel: 'test-model', embeddingDimensions: EMBED_DIM });
    expect(overview).toEqual(expect.objectContaining({ files: 2 }));
    expect(await storageOfOwner(OWNER)).toEqual(expect.objectContaining({ owner_email: OWNER, file_count: 2 }));
    const attachments = await listAttachmentsForFiles(OWNER, [live.id, expired.id]);
    expect(attachments[live.id].map((a) => a.store_id)).toEqual([storeId]);
  });

  it('the candidate scan uses the partial expiry index', async () => {
    // A tiny table may still be planned as a scan; with seqscan off the index must be usable.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const forced = await client.query(
        `EXPLAIN (FORMAT JSON) SELECT id FROM fs_files WHERE expires_at <= now() ORDER BY expires_at, id LIMIT 200`);
      expect(JSON.stringify(forced.rows[0]['QUERY PLAN'])).toContain('idx_fs_files_expires_at');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});

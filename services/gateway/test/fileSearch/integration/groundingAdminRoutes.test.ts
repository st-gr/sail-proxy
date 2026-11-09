// The grounding admin and sharing HANDLERS against a real Postgres database:
// what a non-owner can and cannot do on a shared store (plan decision 1,
// ruling P1), the admin mutations run as the resolved owner (decision 6) with
// the owner's cascade and blob release, sharing only by the owning admin
// (decision 8), and the caller's storage (decision 2). Every property is the
// SQL's, so none of it can be shown against a mock.
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { sha256Of, retainBlob } from '../../../src/fileSearch/blob/blobStore';
import { newFileId } from '../../../src/fileSearch/ids';
import * as repo from '../../../src/fileSearch/repository';
import { createBatch } from '../../../src/fileSearch/batches';
import { storageOfOwner } from '../../../src/fileSearch/groundingQueries';
import * as tableCtrl from '../../../src/controllers/vectorStoresController';
import * as groundingCtrl from '../../../src/controllers/groundingController';
import * as adminCtrl from '../../../src/controllers/groundingAdminController';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const ADMIN = 'admin-owner@example.test';
const ALICE = 'alice@example.test';
const BOB = 'bob@example.test';

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

function baseConfig(): any {
  return {
    enabled: true,
    embeddingModel: 'test-model',
    embeddingDimensions: EMBED_DIM,
    limits: { maxFilesPerStore: 10000, maxFileBytes: 1048576 },
    blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
  };
}

function makeRes(): any {
  const res: any = { headersSent: false, statusCode: 200, headers: {} };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  res.set = (name: any, value?: any) => { res.headers[name] = value; return res; };
  res.setHeader = res.set;
  res.type = () => res;
  res.send = (body: any) => { res.body = body; return res; };
  return res;
}

function req(email: string, overrides: Record<string, any> = {}): any {
  return {
    headers: {}, params: {}, query: {}, body: {},
    apiKeyInfo: { email }, groundingActor: { email, role: email === ADMIN ? 'admin' : 'user' },
    ...overrides,
  };
}

type Handler = (req: any, res: any, next: any) => Promise<void>;

async function call(handler: Handler, email: string, overrides: Record<string, any> = {}): Promise<any> {
  const res = makeRes();
  let failure: unknown = null;
  await handler(req(email, overrides), res, (e: unknown) => { failure = e; });
  if (failure) throw failure;
  return res;
}

d('grounding admin and sharing handlers against a real Postgres database (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  beforeAll(async () => {
    mockConfig = baseConfig();
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

  async function wipe(): Promise<void> {
    await pool.query('DELETE FROM fs_jobs');
    await pool.query('DELETE FROM vector_store_chunks');
    await pool.query('DELETE FROM vector_store_batches');
    await pool.query('DELETE FROM vector_store_files');
    await pool.query('DELETE FROM vector_stores');
    await pool.query('DELETE FROM fs_files');
    await pool.query('DELETE FROM file_blobs');
  }

  beforeEach(async () => {
    mockConfig = baseConfig();
    await wipe();
  });

  async function seedFile(owner: string, filename: string, content?: string): Promise<string> {
    const bytes = Buffer.from(content ?? `${filename}:${crypto.randomBytes(6).toString('hex')}`);
    const sha = sha256Of(bytes);
    await retainBlob(sha, bytes, 'text/plain');
    const id = newFileId();
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
       VALUES ($1,$2,$3,'assistants',$4,$5, now())`,
      [id, owner, filename, sha, bytes.length],
    );
    return id;
  }

  async function seedStore(owner: string, name: string): Promise<string> {
    return (await repo.createStore({ ownerEmail: owner, name })).id;
  }

  async function attach(storeId: string, fileId: string, status = 'completed'): Promise<void> {
    await pool.query(
      `INSERT INTO vector_store_files (store_id, file_id, status, last_error, attempts, created_at)
       VALUES ($1, $2, $3, $4::jsonb, 1, now())`,
      [storeId, fileId, status, status === 'failed' ? JSON.stringify({ message: 'boom', name: 'Error' }) : null],
    );
  }

  async function seedChunk(storeId: string, fileId: string, text: string): Promise<void> {
    await pool.query(
      `INSERT INTO vector_store_chunks (store_id, file_id, ord, text, embedding) VALUES ($1,$2,0,$3,$4::vector)`,
      [storeId, fileId, text, `[${Array.from({ length: EMBED_DIM }, () => Math.random()).join(',')}]`],
    );
  }

  const count = async (sql: string, params: unknown[]): Promise<number> => Number((await pool.query(sql, params)).rows[0].n);

  describe('a shared store, seen by a user who does not own it (decision 1, ruling P1)', () => {
    let shared: string;
    let adminFile: string;
    let aliceFile: string;
    let batchId: string;

    /** ADMIN's shared store with one ingested file and one batch. */
    async function seedSharedStore(): Promise<{ shared: string; adminFile: string; batchId: string }> {
      const store = await seedStore(ADMIN, 'Shared policies');
      const file = await seedFile(ADMIN, 'policy.txt');
      await attach(store, file);
      await seedChunk(store, file, 'policy text');
      const batch = (await createBatch(store, [await seedFile(ADMIN, 'batched.txt')], null, null, {})).id;
      await repo.setStoreShared(store, ADMIN, true);
      return { shared: store, adminFile: file, batchId: batch };
    }

    /** Every store-scoped table route; `ownFile` is a file of the caller, for the attach attempts. */
    function storeAttempts(
      fx: { shared: string; adminFile: string; batchId: string }, ownFile: string,
    ): [string, Handler, Record<string, any>][] {
      const store = { id: fx.shared };
      const storeFile = { id: fx.shared, file_id: fx.adminFile };
      const batch = { id: fx.shared, batch_id: fx.batchId };
      return [
        ['GET /stores/:id/files', tableCtrl.listVectorStoreFiles as Handler, { params: store }],
        ['GET /stores/:id/files/:file_id', tableCtrl.retrieveVectorStoreFile as Handler, { params: storeFile }],
        ['POST /stores/:id/files/:file_id', tableCtrl.modifyVectorStoreFile as Handler, { params: storeFile, body: { attributes: { a: 'b' } } }],
        ['DELETE /stores/:id/files/:file_id', tableCtrl.deleteVectorStoreFile as Handler, { params: storeFile }],
        ['GET /stores/:id/files/:file_id/content', tableCtrl.downloadVectorStoreFileContent as Handler, { params: storeFile }],
        ['POST /stores/:id/files', tableCtrl.createVectorStoreFile as Handler, { params: store, body: { file_id: ownFile } }],
        ['POST /stores/:id/file_batches', tableCtrl.createVectorStoreFileBatch as Handler, { params: store, body: { file_ids: [ownFile] } }],
        ['GET /stores/:id/file_batches/:batch_id', tableCtrl.retrieveVectorStoreFileBatch as Handler, { params: batch }],
        ['POST /stores/:id/file_batches/:batch_id/cancel', tableCtrl.cancelVectorStoreFileBatch as Handler, { params: batch }],
        ['GET /stores/:id/file_batches/:batch_id/files', tableCtrl.listVectorStoreFileBatchFiles as Handler, { params: batch }],
        ['POST /stores/:id/files/:file_id/retry', groundingCtrl.retryStoreFile as Handler, { params: storeFile }],
        ['POST /stores/:id (rename)', tableCtrl.modifyVectorStore as Handler, { params: store, body: { name: 'Taken over' } }],
        ['GET /v1/vector_stores/:id (OpenAI read, unchanged)', tableCtrl.retrieveVectorStore as Handler, { params: store }],
        ['DELETE /stores/:id', tableCtrl.deleteVectorStore as Handler, { params: store }],
      ];
    }

    beforeEach(async () => {
      ({ shared, adminFile, batchId } = await seedSharedStore());
      aliceFile = await seedFile(ALICE, 'mine.txt');
    });

    it('lists it and reads its metadata, with the owner shown and owned false', async () => {
      const mine = await seedStore(ALICE, 'Mine');
      const list = await call(adminCtrl.listStores, ALICE);
      expect(list.statusCode).toBe(200);
      expect(list.body.data.map((s: any) => [s.id, s.owned, s.is_shared, s.owner_email])).toEqual([
        [mine, true, false, ALICE],
        [shared, false, true, ADMIN],
      ]);
      const read = await call(adminCtrl.readStore, ALICE, { params: { id: shared } });
      expect(read.statusCode).toBe(200);
      expect(read.body).toMatchObject({ id: shared, object: 'vector_store', name: 'Shared policies', owned: false, owner_email: ADMIN });
      expect(read.body.file_counts.total).toBe(2);
    });

    it('cannot list its files, read, change, detach, download, attach to, batch, retry, rename or delete it: 404', async () => {
      const attempts = storeAttempts({ shared, adminFile, batchId }, aliceFile);
      const answers: [string, number][] = [];
      for (const [name, handler, overrides] of attempts) {
        // eslint-disable-next-line no-await-in-loop
        answers.push([name, (await call(handler, ALICE, overrides)).statusCode]);
      }
      expect(answers).toEqual(attempts.map(([name]) => [name, 404]));
      const row = await pool.query('SELECT name, is_shared FROM vector_stores WHERE id = $1', [shared]);
      expect(row.rows[0]).toEqual({ name: 'Shared policies', is_shared: true });
      expect(await count('SELECT COUNT(*) AS n FROM vector_store_files WHERE store_id = $1', [shared])).toBe(2);
      expect(await count('SELECT COUNT(*) AS n FROM vector_store_chunks WHERE store_id = $1', [shared])).toBe(1);
    });

    it('positive control: the owner makes the same attempts on a fresh fixture each, and none is a 404', async () => {
      const total = storeAttempts({ shared, adminFile, batchId }, aliceFile).length;
      const answers: [string, number][] = [];
      for (let i = 0; i < total; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await wipe();
        // eslint-disable-next-line no-await-in-loop
        const fx = await seedSharedStore();
        // eslint-disable-next-line no-await-in-loop
        const [name, handler, overrides] = storeAttempts(fx, await seedFile(ADMIN, 'own.txt'))[i];
        // eslint-disable-next-line no-await-in-loop
        answers.push([name, (await call(handler, ADMIN, overrides)).statusCode]);
      }
      expect(answers).toHaveLength(total);
      expect(answers.filter(([, status]) => status === 404 || status >= 500)).toEqual([]);
    });

    it('cannot share or unshare it, even as an admin who does not own it', async () => {
      const otherAdmin = 'second-admin@example.test';
      const res = await call(adminCtrl.unshareStore, otherAdmin, { params: { id: shared }, groundingActor: { email: otherAdmin, role: 'admin' } });
      expect(res.statusCode).toBe(404);
      expect(res.body.error.code).toBe('vector_store_not_found');
      expect((await pool.query('SELECT is_shared FROM vector_stores WHERE id = $1', [shared])).rows[0].is_shared).toBe(true);
    });

    it('drops out of the next list and read once the owner unshares it', async () => {
      const unshared = await call(adminCtrl.unshareStore, ADMIN, { params: { id: shared } });
      expect(unshared.body).toMatchObject({ id: shared, is_shared: false, owned: true, owner_email: ADMIN });
      expect((await call(adminCtrl.listStores, ALICE)).body.data).toEqual([]);
      expect((await call(adminCtrl.readStore, ALICE, { params: { id: shared } })).statusCode).toBe(404);
      // The owner still reads it.
      expect((await call(adminCtrl.readStore, ADMIN, { params: { id: shared } })).body.owned).toBe(true);
    });
  });

  describe('admin mutations as the resolved owner (decision 6)', () => {
    it('deleting another user\'s file detaches it from each of their stores and releases the blob exactly once', async () => {
      const same = 'bytes both users uploaded';
      const file = await seedFile(ALICE, 'handbook.txt', same);
      await seedFile(BOB, 'handbook-copy.txt', same); // the same blob: ref_count 2
      const s1 = await seedStore(ALICE, 'One');
      const s2 = await seedStore(ALICE, 'Two');
      for (const s of [s1, s2]) {
        // eslint-disable-next-line no-await-in-loop
        await attach(s, file);
        // eslint-disable-next-line no-await-in-loop
        await seedChunk(s, file, 'handbook text');
      }
      const sha = sha256Of(Buffer.from(same));
      expect((await pool.query('SELECT ref_count FROM file_blobs WHERE sha256 = $1', [sha])).rows[0].ref_count).toBe(2);

      const res = await call(adminCtrl.deleteFile, ADMIN, { params: { id: file } });
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ id: file, object: 'file', deleted: true });
      expect(await count('SELECT COUNT(*) AS n FROM fs_files WHERE id = $1', [file])).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM vector_store_files WHERE file_id = $1', [file])).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM vector_store_chunks WHERE file_id = $1', [file])).toBe(0);
      expect((await pool.query('SELECT ref_count FROM file_blobs WHERE sha256 = $1', [sha])).rows[0].ref_count).toBe(1);

      expect((await call(adminCtrl.deleteFile, ADMIN, { params: { id: file } })).statusCode).toBe(404);
    });

    it('deleting another user\'s store with ingestion running cascades like the owner\'s delete and keeps the files', async () => {
      const file = await seedFile(BOB, 'running.txt');
      const store = await seedStore(BOB, 'Busy');
      await attach(store, file, 'in_progress');
      await seedChunk(store, file, 'partial');

      const res = await call(adminCtrl.deleteStore, ADMIN, { params: { id: store } });
      expect(res.body).toEqual({ id: store, object: 'vector_store.deleted', deleted: true });
      expect(await count('SELECT COUNT(*) AS n FROM vector_stores WHERE id = $1', [store])).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM vector_store_files WHERE store_id = $1', [store])).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM vector_store_chunks WHERE store_id = $1', [store])).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM fs_files WHERE id = $1', [file])).toBe(1);
      expect((await call(adminCtrl.deleteStore, ADMIN, { params: { id: store } })).statusCode).toBe(404);
    });

    it('retries another user\'s failed ingestion', async () => {
      const file = await seedFile(BOB, 'broken.txt');
      const store = await seedStore(BOB, 'Store');
      await attach(store, file, 'failed');

      const res = await call(adminCtrl.retryStoreFile, ADMIN, { params: { id: store, file_id: file } });
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ job_id: null, job: null, retried: 1 });
      expect((await pool.query('SELECT status FROM vector_store_files WHERE store_id = $1 AND file_id = $2', [store, file])).rows[0].status)
        .toBe('in_progress');
      const again = await call(adminCtrl.retryStoreFile, ADMIN, { params: { id: store, file_id: file } });
      expect([again.statusCode, again.body.error.code]).toEqual([409, 'nothing_to_retry']);
    });

    it('shares only a store the acting admin owns', async () => {
      const own = await seedStore(ADMIN, 'Own');
      const alices = await seedStore(ALICE, 'Alice');
      const shared = await call(adminCtrl.shareStore, ADMIN, { params: { id: own } });
      expect(shared.body).toMatchObject({ id: own, is_shared: true, owned: true, owner_email: ADMIN });
      const refused = await call(adminCtrl.shareStore, ADMIN, { params: { id: alices } });
      expect(refused.statusCode).toBe(404);
      expect((await pool.query('SELECT is_shared FROM vector_stores WHERE id = $1', [alices])).rows[0].is_shared).toBe(false);
    });
  });

  describe('the admin lists through the handlers', () => {
    it('pages storage per owner on the e-mail cursor', async () => {
      await seedFile(ALICE, 'a.txt', '123');
      await seedFile(BOB, 'b.txt', '12345');
      await seedFile(ADMIN, 'x.txt', '1');
      const first = await call(adminCtrl.listStorage, ADMIN, { query: { limit: '2' } });
      expect(first.body).toEqual({
        object: 'list', has_more: true, first_id: ADMIN, last_id: ALICE,
        data: [{ owner_email: ADMIN, file_count: 1, logical_bytes: 1 }, { owner_email: ALICE, file_count: 1, logical_bytes: 3 }],
      });
      const second = await call(adminCtrl.listStorage, ADMIN, { query: { limit: '2', after: first.body.last_id } });
      expect(second.body).toEqual({
        object: 'list', has_more: false, first_id: BOB, last_id: BOB,
        data: [{ owner_email: BOB, file_count: 1, logical_bytes: 5 }],
      });
    });

    it('lists everyone\'s stores as store objects with usage and the owner', async () => {
      const store = await seedStore(BOB, 'Bob');
      await attach(store, await seedFile(BOB, 'b.txt'), 'failed');
      const res = await call(adminCtrl.listAllStores, ADMIN, { query: { owner: BOB } });
      expect(res.body.data).toEqual([expect.objectContaining({
        id: store, object: 'vector_store', owner_email: BOB, owned: false, is_shared: false,
        file_counts: { in_progress: 0, completed: 0, failed: 1, cancelled: 0, total: 1 },
      })]);
    });
  });

  describe('storageOfOwner (GET /storage)', () => {
    it('counts the owner\'s files and logical bytes, deduplicated content counted per file', async () => {
      await seedFile(ALICE, 'a.txt', 'same');
      await seedFile(ALICE, 'b.txt', 'same');
      await seedFile(ALICE, 'c.txt', '1234567');
      await seedFile(BOB, 'd.txt', 'not alice');
      expect(await storageOfOwner(ALICE)).toEqual({ owner_email: ALICE, file_count: 3, logical_bytes: 15 });
      expect(await storageOfOwner('nobody@example.test')).toEqual({ owner_email: 'nobody@example.test', file_count: 0, logical_bytes: 0 });
      // Exact equality: neither case nor a pattern widens it.
      expect((await storageOfOwner('ALICE@example.test')).file_count).toBe(0);
      expect((await storageOfOwner('%')).file_count).toBe(0);
      const res = await call(adminCtrl.storage, ALICE);
      expect(res.body).toEqual({ owner_email: ALICE, file_count: 3, logical_bytes: 15 });
    });
  });

  describe('a store\'s file list on a cockpit call carries each file\'s context stop (contextStop.ts)', () => {
    it('context_stopped on the grounding list and batch list; the OpenAI-shaped object without it', async () => {
      const store = await seedStore(ALICE, 'Docs');
      const stopped = await seedFile(ALICE, 'long.md');
      const plain = await seedFile(ALICE, 'short.md');
      await attach(store, stopped);
      await attach(store, plain);
      await pool.query(`UPDATE vector_store_files SET context_stopped = 'deadline_retried' WHERE file_id = $1`, [stopped]);
      const batch = (await createBatch(store, [await seedFile(ALICE, 'batched.md')], null, null, {})).id;
      await pool.query(`UPDATE vector_store_files SET context_stopped = 'budget' WHERE batch_id = $1`, [batch]);

      const cockpit = await call(tableCtrl.listVectorStoreFiles as Handler, ALICE, { params: { id: store } });
      expect(cockpit.statusCode).toBe(200);
      const byId = Object.fromEntries(cockpit.body.data.map((f: any) => [f.id, f.context_stopped]));
      expect(byId).toMatchObject({ [stopped]: 'deadline_retried', [plain]: null });
      const batchList = await call(tableCtrl.listVectorStoreFileBatchFiles as Handler, ALICE, { params: { id: store, batch_id: batch } });
      expect(batchList.body.data.map((f: any) => f.context_stopped)).toEqual(['budget']);

      // The same handlers on the OpenAI-compatible routes (no acting cockpit user): OpenAI's shape only.
      const api = await call(tableCtrl.listVectorStoreFiles as Handler, ALICE, { params: { id: store }, groundingActor: undefined });
      expect(api.body.data).toHaveLength(3);
      for (const f of api.body.data) expect(f).not.toHaveProperty('context_stopped');
      const apiBatch = await call(tableCtrl.listVectorStoreFileBatchFiles as Handler, ALICE,
        { params: { id: store, batch_id: batch }, groundingActor: undefined });
      expect(apiBatch.body.data[0]).not.toHaveProperty('context_stopped');
    });
  });
});

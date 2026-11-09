// The grounding ADMIN data layer and store SHARING against a real Postgres
// database: every property here is SQL — the all-owner keyset lists, the
// owner-scoped share UPDATE, the shared-aware visibility predicate and the
// indexes the lists walk — so none of it can be shown against a mock.
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { sha256Of, retainBlob } from '../../../src/fileSearch/blob/blobStore';
import { newFileId } from '../../../src/fileSearch/ids';
import * as repo from '../../../src/fileSearch/repository';
import { createBatch, requestBatchCancel } from '../../../src/fileSearch/batches';
import * as admin from '../../../src/fileSearch/admin';
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
    limits: { maxFilesPerStore: 10000 },
    blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
  };
}

/** Column names that must never appear in an admin row (spec §5.1, plan decision 9). */
const TARGET = { embeddingModel: 'test-model', embeddingDimensions: EMBED_DIM };
const FORBIDDEN_KEYS = ['text', 'bytes', 'location', 'sha256', 'tsv', 'embedding', 'chunk_text'];

d('grounding admin queries and store sharing against a real Postgres database (requires FILE_SEARCH_TEST_DSN)', () => {
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

  beforeEach(async () => {
    mockConfig = baseConfig();
    await pool.query('DELETE FROM fs_jobs');
    await pool.query('DELETE FROM vector_store_chunks');
    await pool.query('DELETE FROM vector_store_batches');
    await pool.query('DELETE FROM vector_store_files');
    await pool.query('DELETE FROM vector_stores');
    await pool.query('DELETE FROM fs_files');
    await pool.query('DELETE FROM file_blobs');
  });

  /** A file whose bytes are `content` (random when omitted); same content dedupes into one blob. */
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

  /** Pins created_at so the newest-first order is known regardless of clock resolution. */
  async function setCreated(table: 'vector_stores' | 'fs_files', id: string, minutesAgo: number): Promise<void> {
    await pool.query(`UPDATE ${table} SET created_at = now() - ($2::int * interval '1 minute') WHERE id = $1`, [id, minutesAgo]);
  }

  async function attach(storeId: string, fileId: string, status = 'in_progress', lastError: unknown = null, minutesAgo = 0): Promise<void> {
    await pool.query(
      `INSERT INTO vector_store_files (store_id, file_id, status, last_error, attempts, created_at)
       VALUES ($1, $2, $3, $4::jsonb, 1, now() - ($5::int * interval '1 minute'))`,
      [storeId, fileId, status, lastError === null ? null : JSON.stringify(lastError), minutesAgo],
    );
  }

  function expectNoForbiddenKeys(rows: object[]): void {
    for (const row of rows) {
      for (const key of FORBIDDEN_KEYS) expect(Object.keys(row)).not.toContain(key);
    }
  }

  /** Walks a list to the end with `limit`, returning every page's ids. */
  async function pageThrough<T>(fetch: (after: string | null) => Promise<T[]>, limit: number, idOf: (row: T) => string): Promise<string[][]> {
    const pages: string[][] = [];
    let after: string | null = null;
    for (let guard = 0; guard < 50; guard += 1) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await fetch(after);
      const page = rows.slice(0, limit);
      pages.push(page.map(idOf));
      if (rows.length <= limit) return pages;
      after = idOf(page[page.length - 1]);
    }
    throw new Error('paging did not terminate');
  }

  describe('overview', () => {
    it('counts stores, files and failed ingestions, and computes savings from a deduplicated blob', async () => {
      const same = 'the same handbook bytes';
      const a = await seedFile(ALICE, 'handbook.txt', same);
      const b = await seedFile(BOB, 'copy-of-handbook.txt', same);
      const c = await seedFile(BOB, 'notes.txt', 'twelve bytes');
      const store = await seedStore(ALICE, 'Docs');
      await seedStore(BOB, 'Other');
      await attach(store, a, 'failed', { message: 'unsupported', name: 'UnsupportedFileTypeError' });

      const blobs = await pool.query('SELECT ref_count FROM file_blobs ORDER BY ref_count DESC');
      expect(blobs.rows.map((r) => r.ref_count)).toEqual([2, 1]);

      const result = await admin.overview(TARGET);
      const logical = 2 * same.length + 'twelve bytes'.length;
      const physical = same.length + 'twelve bytes'.length;
      expect(result).toEqual({
        stores: 2,
        files: 3,
        logical_bytes: logical,
        physical_bytes: physical,
        savings_bytes: same.length,
        failed_ingestions: 1,
        outdated_stores: 0,
      });
      expect(result.logical_bytes - result.physical_bytes).toBe(result.savings_bytes);
      // The two owners' copies share one content hash (one blob); the third file has its own.
      const hashes = await pool.query('SELECT id, sha256 FROM fs_files WHERE id = ANY($1::text[])', [[a, b, c]]);
      const shaOf = new Map(hashes.rows.map((r) => [r.id, r.sha256]));
      expect(shaOf.get(a)).toBe(shaOf.get(b));
      expect(shaOf.get(c)).not.toBe(shaOf.get(a));
    });

    it('is all zeros on an empty tenant', async () => {
      expect(await admin.overview(TARGET)).toEqual({
        stores: 0, files: 0, logical_bytes: 0, physical_bytes: 0, savings_bytes: 0, failed_ingestions: 0, outdated_stores: 0,
      });
    });

    it('counts the outdated stores: another model with the configured dimension; a dimension mismatch is not outdated', async () => {
      const current = await seedStore(ALICE, 'Current');
      const old1 = await seedStore(ALICE, 'Old');
      const old2 = await seedStore(BOB, 'Old too');
      const otherDim = await seedStore(BOB, 'Other dimension');
      await pool.query(`UPDATE vector_stores SET embedding_model = 'old-model' WHERE id = ANY($1::text[])`, [[old1, old2]]);
      await pool.query(`UPDATE vector_stores SET embedding_model = 'old-model', embedding_dim = 8 WHERE id = $1`, [otherDim]);
      expect((await admin.overview(TARGET)).outdated_stores).toBe(2);
      // Measured against the target passed in: with old-model configured, only the current store is outdated.
      expect((await admin.overview({ embeddingModel: 'old-model', embeddingDimensions: EMBED_DIM })).outdated_stores).toBe(1);
      expect(current).toBeDefined();
    });

    it('leaves expired stores out of the outdated count, like the bulk re-embed does (ruling R9)', async () => {
      const old1 = await seedStore(ALICE, 'Old');
      const old2 = await seedStore(BOB, 'Old and expired');
      await pool.query(`UPDATE vector_stores SET embedding_model = 'old-model' WHERE id = ANY($1::text[])`, [[old1, old2]]);
      await pool.query(`UPDATE vector_stores SET status = 'expired' WHERE id = $1`, [old2]);
      expect((await admin.overview(TARGET)).outdated_stores).toBe(1);
      // The admin list's embedding_state filter still lists the expired store as outdated.
      const outdated = await admin.listAllStores({ embeddingState: { state: 'outdated', target: TARGET }, limit: 10 });
      expect(outdated.map((r) => r.id).sort()).toEqual([old1, old2].sort());
    });
  });

  describe('listAllStores', () => {
    it('lists every owner newest first, pages with after, and filters by exact owner and shared', async () => {
      const ids: string[] = [];
      const owners = [ALICE, BOB, ALICE, ADMIN, BOB];
      for (let i = 0; i < owners.length; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const id = await seedStore(owners[i], `S${i}`);
        // eslint-disable-next-line no-await-in-loop
        await setCreated('vector_stores', id, 100 - i); // S4 newest
        ids.push(id);
      }
      await repo.setStoreShared(ids[3], ADMIN, true);

      const pages = await pageThrough((after) => admin.listAllStores({ after, limit: 2 }), 2, (r) => r.id);
      expect(pages).toEqual([[ids[4], ids[3]], [ids[2], ids[1]], [ids[0]]]);

      expect((await admin.listAllStores({ owner: ALICE, limit: 10 })).map((r) => r.id)).toEqual([ids[2], ids[0]]);
      // Exact match: no case folding, no pattern.
      expect(await admin.listAllStores({ owner: 'ALICE@example.test', limit: 10 })).toEqual([]);
      expect(await admin.listAllStores({ owner: '%@example.test', limit: 10 })).toEqual([]);

      expect((await admin.listAllStores({ shared: true, limit: 10 })).map((r) => r.id)).toEqual([ids[3]]);
      expect((await admin.listAllStores({ shared: false, limit: 10 }))).toHaveLength(4);

      const row = (await admin.listAllStores({ owner: ADMIN, limit: 10 }))[0];
      expect(row).toMatchObject({ id: ids[3], owner_email: ADMIN, is_shared: true, name: 'S3' });
      expect(Object.keys(row).sort()).toEqual([
        'active_generation', 'chunking', 'created_at', 'embedding_dim', 'embedding_model', 'expires_after', 'expires_at', 'id',
        'is_shared', 'last_active_at', 'metadata', 'name', 'owner_email', 'status',
      ]);
    });

    it('filters by the derived status: in_progress from the files, expired from the row', async () => {
      const busy = await seedStore(ALICE, 'Busy');
      const done = await seedStore(ALICE, 'Done');
      const gone = await seedStore(BOB, 'Gone');
      const f1 = await seedFile(ALICE, 'a.txt');
      const f2 = await seedFile(ALICE, 'b.txt');
      await attach(busy, f1, 'in_progress');
      await attach(done, f2, 'completed');
      // The row says in_progress, but nothing is: derived 'completed', as the API reports it.
      await pool.query(`UPDATE vector_stores SET status = 'in_progress' WHERE id = $1`, [done]);
      await pool.query(`UPDATE vector_stores SET status = 'expired' WHERE id = $1`, [gone]);

      expect((await admin.listAllStores({ status: 'in_progress', limit: 10 })).map((r) => r.id)).toEqual([busy]);
      expect((await admin.listAllStores({ status: 'completed', limit: 10 })).map((r) => r.id)).toEqual([done]);
      expect((await admin.listAllStores({ status: 'expired', limit: 10 })).map((r) => r.id)).toEqual([gone]);
    });

    it('filters by the embedding state against the target passed in, combined with the other filters and paging', async () => {
      const current = await seedStore(ALICE, 'Current');
      const old1 = await seedStore(ALICE, 'Old');
      const old2 = await seedStore(BOB, 'Old too');
      const otherDim = await seedStore(BOB, 'Other dimension');
      await setCreated('vector_stores', current, 40);
      await setCreated('vector_stores', old1, 30);
      await setCreated('vector_stores', old2, 20);
      await setCreated('vector_stores', otherDim, 10);
      await pool.query(`UPDATE vector_stores SET embedding_model = 'old-model' WHERE id = ANY($1::text[])`, [[old1, old2]]);
      await pool.query(`UPDATE vector_stores SET embedding_model = 'old-model', embedding_dim = 8 WHERE id = $1`, [otherDim]);
      const state = (name: 'current' | 'outdated' | 'dimension_mismatch', target = TARGET) => ({ state: name, target });

      expect((await admin.listAllStores({ embeddingState: state('current'), limit: 10 })).map((r) => r.id)).toEqual([current]);
      expect((await admin.listAllStores({ embeddingState: state('outdated'), limit: 10 })).map((r) => r.id)).toEqual([old2, old1]);
      expect((await admin.listAllStores({ embeddingState: state('dimension_mismatch'), limit: 10 })).map((r) => r.id)).toEqual([otherDim]);
      // The same rule as the overview's outdated count and embeddingState(): measured against the target, not the config.
      const oldTarget = { embeddingModel: 'old-model', embeddingDimensions: EMBED_DIM };
      expect((await admin.listAllStores({ embeddingState: state('outdated', oldTarget), limit: 10 })).map((r) => r.id)).toEqual([current]);
      expect((await admin.listAllStores({ embeddingState: state('current', oldTarget), limit: 10 })).map((r) => r.id)).toEqual([old2, old1]);
      expect((await admin.overview(TARGET)).outdated_stores).toBe(2);
      // Combined with owner, and paged with after.
      expect((await admin.listAllStores({ owner: ALICE, embeddingState: state('outdated'), limit: 10 })).map((r) => r.id)).toEqual([old1]);
      const pages = await pageThrough((after) => admin.listAllStores({ embeddingState: state('outdated'), after, limit: 1 }), 1, (r) => r.id);
      expect(pages).toEqual([[old2], [old1]]);
      // Refused input: an unknown state, or a state without a usable target.
      await expect(admin.listAllStores({ limit: 10, embeddingState: { state: 'stale' as any, target: TARGET } }))
        .rejects.toBeInstanceOf(admin.AdminQueryInputError);
      await expect(admin.listAllStores({ limit: 10, embeddingState: { state: 'outdated', target: null as any } }))
        .rejects.toThrow('target');
    });

    it('gives an empty page for an unknown cursor and refuses bad input', async () => {
      await seedStore(ALICE, 'A');
      expect(await admin.listAllStores({ after: 'vs_unknown', limit: 10 })).toEqual([]);
      await expect(admin.listAllStores({ limit: 0 })).rejects.toBeInstanceOf(admin.AdminQueryInputError);
      await expect(admin.listAllStores({ limit: 101 })).rejects.toBeInstanceOf(admin.AdminQueryInputError);
      await expect(admin.listAllStores({ limit: 1.5 })).rejects.toBeInstanceOf(admin.AdminQueryInputError);
      await expect(admin.listAllStores({ limit: 10, status: 'failed' as any })).rejects.toBeInstanceOf(admin.AdminQueryInputError);
      await expect(admin.listAllStores({ limit: 10, shared: 'yes' as any })).rejects.toBeInstanceOf(admin.AdminQueryInputError);
      await expect(admin.listAllStores({ limit: 10, owner: '' })).rejects.toBeInstanceOf(admin.AdminQueryInputError);
      await expect(admin.listAllStores({ limit: 10, owner: `a${String.fromCharCode(0)}b` }))
        .rejects.toBeInstanceOf(admin.AdminQueryInputError);
    });
  });

  describe('listAllFiles', () => {
    it('lists every owner\'s files newest first with metadata only, pages and filters by owner', async () => {
      const ids: string[] = [];
      const owners = [ALICE, BOB, BOB, ALICE];
      for (let i = 0; i < owners.length; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const id = await seedFile(owners[i], `f${i}.txt`);
        // eslint-disable-next-line no-await-in-loop
        await setCreated('fs_files', id, 100 - i);
        ids.push(id);
      }
      const s1 = await seedStore(ALICE, 'One');
      const s2 = await seedStore(ALICE, 'Two');
      await attach(s1, ids[3]); await attach(s2, ids[3]);

      const pages = await pageThrough((after) => admin.listAllFiles({ after, limit: 3 }), 3, (r) => r.id);
      expect(pages).toEqual([[ids[3], ids[2], ids[1]], [ids[0]]]);
      expect((await admin.listAllFiles({ owner: BOB, limit: 10 })).map((r) => r.id)).toEqual([ids[2], ids[1]]);

      const [row] = await admin.listAllFiles({ owner: ALICE, limit: 1 });
      expect(row).toMatchObject({ id: ids[3], owner_email: ALICE, filename: 'f3.txt', purpose: 'assistants', attachment_count: 2 });
      expect(typeof row.size_bytes).toBe('number');
      expect(Object.keys(row).sort()).toEqual(['attachment_count', 'created_at', 'filename', 'id', 'owner_email', 'purpose', 'size_bytes']);
      expect(await admin.listAllFiles({ after: 'file-unknown', limit: 10 })).toEqual([]);
    });
  });

  describe('listFailedAttachments', () => {
    it('lists failed attachments with only the sanitised message and name, pages and filters by owner', async () => {
      const aliceStore = await seedStore(ALICE, 'Alice docs');
      const bobStore = await seedStore(BOB, 'Bob docs');
      const fa = await seedFile(ALICE, 'scan.pdf');
      const fb = await seedFile(ALICE, 'ok.txt');
      const fc = await seedFile(BOB, 'broken.docx');
      const fd = await seedFile(BOB, 'old.docx');
      await attach(aliceStore, fa, 'failed',
        { message: 'Extraction timed out', name: 'ExtractionTimeoutError', stack: 'at /srv/secret/path.js:1', detail: 'raw driver text' }, 3);
      await attach(aliceStore, fb, 'completed', null, 2);
      await attach(bobStore, fc, 'failed', { message: 'Unsupported file type', name: 'UnsupportedFileTypeError' }, 1);
      await attach(bobStore, fd, 'failed', { message: 'Older failure' }, 4);

      const all = await admin.listFailedAttachments({ limit: 10 });
      expect(all.map((r) => r.file_id)).toEqual([fc, fa, fd]);
      const aliceRow = all[1];
      expect(aliceRow).toMatchObject({
        id: `${aliceStore}/${fa}`, store_id: aliceStore, store_name: 'Alice docs', file_id: fa, filename: 'scan.pdf',
        owner_email: ALICE, attempts: 1, batch_id: null,
      });
      expect(aliceRow.last_error).toEqual({ message: 'Extraction timed out', name: 'ExtractionTimeoutError' });
      expect(all[2].last_error).toEqual({ message: 'Older failure', name: null });
      expect(Object.keys(aliceRow).sort()).toEqual([
        'attempts', 'batch_id', 'created_at', 'file_id', 'filename', 'id', 'last_error', 'owner_email', 'store_id', 'store_name',
      ]);
      expect(JSON.stringify(all)).not.toContain('secret');
      expect(JSON.stringify(all)).not.toContain('raw driver text');

      const pages = await pageThrough((after) => admin.listFailedAttachments({ after, limit: 1 }), 1, (r) => r.id);
      expect(pages).toEqual([[`${bobStore}/${fc}`], [`${aliceStore}/${fa}`], [`${bobStore}/${fd}`]]);
      expect((await admin.listFailedAttachments({ owner: BOB, limit: 10 })).map((r) => r.file_id)).toEqual([fc, fd]);
      expect(await admin.listFailedAttachments({ after: 'vs_x/file-y', limit: 10 })).toEqual([]);
      await expect(admin.listFailedAttachments({ after: 'no-slash', limit: 10 })).rejects.toBeInstanceOf(admin.AdminQueryInputError);
    });

    it('narrows to one batch\'s failed members with batchId', async () => {
      const store = await seedStore(ALICE, 'Alice docs');
      const [f1, f2, f3, loose] = [await seedFile(ALICE, 'a.pdf'), await seedFile(ALICE, 'b.pdf'), await seedFile(ALICE, 'c.pdf'),
        await seedFile(ALICE, 'loose.pdf')];
      const batch = await createBatch(store, [f1, f2, f3], null, null);
      await attach(store, loose, 'failed', { message: 'outside the batch' }, 1);
      await pool.query(
        `UPDATE vector_store_files SET status = CASE WHEN file_id = $2 THEN 'completed' ELSE 'failed' END,
                last_error = '{"message":"boom"}'::jsonb WHERE store_id = $1 AND batch_id IS NOT NULL`, [store, f2]);
      const rows = await admin.listFailedAttachments({ batchId: batch.id, limit: 10 });
      expect(rows.map((r) => r.file_id).sort()).toEqual([f1, f3].sort());
      expect(rows.every((r) => r.batch_id === batch.id)).toBe(true);
      expect(await admin.listFailedAttachments({ batchId: 'vsfb_unknown', limit: 10 })).toEqual([]);
      await expect(admin.listFailedAttachments({ batchId: '', limit: 10 })).rejects.toBeInstanceOf(admin.AdminQueryInputError);
    });
  });

  describe('storageByOwner', () => {
    it('sums file count and logical bytes per owner, ordered and paged by e-mail', async () => {
      await seedFile(BOB, 'b1.txt', 'abc');
      await seedFile(BOB, 'b2.txt', 'abc'); // same content: one blob, still logical bytes twice
      await seedFile(ALICE, 'a1.txt', '12345');
      await seedFile(ADMIN, 'x.txt', '1');

      const all = await admin.storageByOwner({ limit: 10 });
      expect(all).toEqual([
        { owner_email: ADMIN, file_count: 1, logical_bytes: 1 },
        { owner_email: ALICE, file_count: 1, logical_bytes: 5 },
        { owner_email: BOB, file_count: 2, logical_bytes: 6 },
      ]);
      const pages = await pageThrough((after) => admin.storageByOwner({ after, limit: 2 }), 2, (r) => r.owner_email);
      expect(pages).toEqual([[ADMIN, ALICE], [BOB]]);
    });

    it('pages past an owner whose e-mail is longer than an id cursor (254 characters)', async () => {
      const longOwner = `${'a'.repeat(254 - '@example.test'.length)}@example.test`;
      expect(longOwner).toHaveLength(254);
      await seedFile(longOwner, 'long.txt', 'ab');
      await seedFile(BOB, 'b1.txt', 'abc');

      const pages = await pageThrough((after) => admin.storageByOwner({ after, limit: 1 }), 1, (r) => r.owner_email);
      expect(pages).toEqual([[longOwner], [BOB]]);
    });
  });

  describe('listAllJobs', () => {
    async function seedBatchJob(owner: string, n: number): Promise<{ storeId: string; batchId: string; jobId: string; fileIds: string[] }> {
      const storeId = await seedStore(owner, `${owner} batch store`);
      const fileIds: string[] = [];
      for (let i = 0; i < n; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        fileIds.push(await seedFile(owner, `j${i}.txt`));
      }
      const batch = await createBatch(storeId, fileIds, null, null, {});
      const { rows } = await pool.query<{ id: string }>('SELECT id FROM fs_jobs WHERE batch_id = $1', [batch.id]);
      return { storeId, batchId: batch.id, jobId: rows[0].id, fileIds };
    }

    it('lists every owner\'s jobs with the derived state and the owner, pages and filters', async () => {
      const a = await seedBatchJob(ALICE, 2);
      const b = await seedBatchJob(BOB, 1);
      const c = await seedBatchJob(BOB, 1);
      await pool.query(`UPDATE fs_jobs SET created_at = now() - interval '3 minutes' WHERE id = $1`, [a.jobId]);
      await pool.query(`UPDATE fs_jobs SET created_at = now() - interval '2 minutes' WHERE id = $1`, [b.jobId]);
      await pool.query(`UPDATE fs_jobs SET created_at = now() - interval '1 minute' WHERE id = $1`, [c.jobId]);
      await pool.query(`UPDATE vector_store_files SET status = 'completed', attempts = 1 WHERE store_id = $1`, [b.storeId]);
      await pool.query(
        `UPDATE vector_store_files SET status = 'failed', attempts = 1, last_error = '{"message":"boom"}' WHERE store_id = $1 AND file_id = $2`,
        [a.storeId, a.fileIds[0]],
      );
      await pool.query(`UPDATE vector_store_files SET status = 'completed', attempts = 1 WHERE store_id = $1 AND file_id = $2`, [a.storeId, a.fileIds[1]]);
      await requestBatchCancel(c.storeId, c.batchId);

      const all = await admin.listAllJobs({ limit: 10 });
      expect(all.map((j) => [j.id, j.owner_email, j.state])).toEqual([
        [c.jobId, BOB, 'cancelling'],
        [b.jobId, BOB, 'completed'],
        [a.jobId, ALICE, 'completed_with_errors'],
      ]);
      expect(all[2]).toMatchObject({ total: 2, done: 1, failed: 1, in_progress: 0, embedding_tokens: 0 });

      const pages = await pageThrough((after) => admin.listAllJobs({ after, limit: 2 }), 2, (r) => r.id);
      expect(pages).toEqual([[c.jobId, b.jobId], [a.jobId]]);
      expect((await admin.listAllJobs({ owner: ALICE, limit: 10 })).map((j) => j.id)).toEqual([a.jobId]);
      expect((await admin.listAllJobs({ state: 'completed', limit: 10 })).map((j) => j.id)).toEqual([b.jobId]);
      expect((await admin.listAllJobs({ owner: BOB, state: 'cancelling', limit: 10 })).map((j) => j.id)).toEqual([c.jobId]);
      await expect(admin.listAllJobs({ state: 'done' as any, limit: 10 })).rejects.toBeInstanceOf(admin.AdminQueryInputError);
    });
  });

  describe('owner resolution', () => {
    it('resolves the owner of a store and a file, null for an unknown id', async () => {
      const store = await seedStore(ALICE, 'A');
      const file = await seedFile(BOB, 'b.txt');
      expect(await admin.ownerOfStore(store)).toBe(ALICE);
      expect(await admin.ownerOfFile(file)).toBe(BOB);
      expect(await admin.ownerOfStore('vs_unknown')).toBeNull();
      expect(await admin.ownerOfFile('file-unknown')).toBeNull();
    });
  });

  describe('sharing and shared-aware reads', () => {
    it('only the owner can share or unshare; anyone else is not_found and changes nothing', async () => {
      const store = await seedStore(ADMIN, 'Policies');
      const shared = await repo.setStoreShared(store, ADMIN, true);
      expect(shared).toMatchObject({ id: store, is_shared: true, owner_email: ADMIN });

      expect(await repo.setStoreShared(store, ALICE, false)).toBeNull();
      expect((await pool.query('SELECT is_shared FROM vector_stores WHERE id = $1', [store])).rows[0].is_shared).toBe(true);
      expect(await repo.setStoreShared('vs_unknown', ADMIN, true)).toBeNull();

      expect(await repo.setStoreShared(store, ADMIN, false)).toMatchObject({ is_shared: false });
    });

    it('a user lists their own stores and every shared one, flagged, never another owner\'s private store', async () => {
      const mine = await seedStore(ALICE, 'Mine');
      const sharedByAdmin = await seedStore(ADMIN, 'Shared policies');
      const privateOfAdmin = await seedStore(ADMIN, 'Admin private');
      const privateOfBob = await seedStore(BOB, 'Bob private');
      await setCreated('vector_stores', mine, 4);
      await setCreated('vector_stores', sharedByAdmin, 3);
      await setCreated('vector_stores', privateOfAdmin, 2);
      await setCreated('vector_stores', privateOfBob, 1);
      await repo.setStoreShared(sharedByAdmin, ADMIN, true);

      const visible = await repo.listVisibleStores(ALICE, { limit: 10 });
      expect(visible.map((s) => [s.id, s.owned, s.owner_email, s.is_shared])).toEqual([
        [sharedByAdmin, false, ADMIN, true],
        [mine, true, ALICE, false],
      ]);
      // The owner sees their shared store as owned.
      expect((await repo.listVisibleStores(ADMIN, { limit: 10 })).map((s) => [s.id, s.owned]))
        .toEqual([[privateOfAdmin, true], [sharedByAdmin, true]]);

      // Paging, and a cursor naming a store the caller cannot see gives an empty page.
      const first = await repo.listVisibleStores(ALICE, { limit: 1 });
      expect(first.map((s) => s.id)).toEqual([sharedByAdmin, mine]);
      expect((await repo.listVisibleStores(ALICE, { limit: 1, after: sharedByAdmin })).map((s) => s.id)).toEqual([mine]);
      expect(await repo.listVisibleStores(ALICE, { limit: 10, after: privateOfBob })).toEqual([]);

      expect(await repo.readVisibleStore(ALICE, sharedByAdmin)).toMatchObject({ id: sharedByAdmin, owned: false, owner_email: ADMIN });
      expect(await repo.readVisibleStore(ALICE, mine)).toMatchObject({ id: mine, owned: true });
      expect(await repo.readVisibleStore(ALICE, privateOfBob)).toBeNull();
      expect(await repo.readVisibleStore(ALICE, 'vs_unknown')).toBeNull();

      // Unsharing takes effect on the next read.
      await repo.setStoreShared(sharedByAdmin, ADMIN, false);
      expect((await repo.listVisibleStores(ALICE, { limit: 10 })).map((s) => s.id)).toEqual([mine]);
      expect(await repo.readVisibleStore(ALICE, sharedByAdmin)).toBeNull();
      await expect(repo.listVisibleStores('', { limit: 10 })).rejects.toThrow('non-empty');
    });

    it('treats an empty cursor as no cursor and refuses a page size outside 1-100', async () => {
      const mine = await seedStore(ALICE, 'Mine');
      expect((await repo.listVisibleStores(ALICE, { limit: 10, after: '' })).map((s) => s.id)).toEqual([mine]);
      for (const limit of [0, -1, 1.5, 101, Number.NaN]) {
        // eslint-disable-next-line no-await-in-loop
        await expect(repo.listVisibleStores(ALICE, { limit })).rejects.toThrow(RangeError);
      }
      expect(await repo.listVisibleStores(ALICE, { limit: 100 })).toHaveLength(1);
    });

    it('sharing does not open the owner-scoped mutations to another user', async () => {
      const store = await seedStore(ADMIN, 'Shared');
      await repo.setStoreShared(store, ADMIN, true);
      expect(await repo.deleteStoreCascade(store, ALICE)).toEqual({ deleted: false });
      expect((await pool.query('SELECT 1 FROM vector_stores WHERE id = $1', [store])).rowCount).toBe(1);
    });
  });

  describe('no admin row carries content', () => {
    it('no list returns chunk text, blob bytes, hashes or locations', async () => {
      const store = await seedStore(ALICE, 'Docs');
      const file = await seedFile(ALICE, 'a.txt');
      await attach(store, file, 'failed', { message: 'm', name: 'n' });
      await pool.query(
        `INSERT INTO vector_store_chunks (store_id, file_id, ord, text, embedding) VALUES ($1, $2, 0, 'secret chunk', '[1,0,0]')`,
        [store, file],
      );
      const batchStore = await seedStore(BOB, 'Batch');
      await createBatch(batchStore, [await seedFile(BOB, 'b.txt')], null, null, {});
      const lists: object[][] = [
        await admin.listAllStores({ limit: 10 }),
        await admin.listAllFiles({ limit: 10 }),
        await admin.listFailedAttachments({ limit: 10 }),
        await admin.storageByOwner({ limit: 10 }),
        await admin.listAllJobs({ limit: 10 }),
        [await admin.overview(TARGET)],
      ];
      for (const rows of lists) {
        expect(rows.length).toBeGreaterThan(0);
        expectNoForbiddenKeys(rows);
        expect(JSON.stringify(rows)).not.toContain('secret chunk');
      }
    });
  });

  describe('indexes on a tenant of realistic size', () => {
    const OWNERS = 40;
    const ROWS = 4000;

    beforeEach(async () => {
      const blob = Buffer.from('seed');
      await retainBlob(sha256Of(blob), blob, 'text/plain');
      await pool.query(
        `INSERT INTO vector_stores (id, owner_email, name, status, embedding_model, embedding_dim, created_at)
         SELECT 'vs_seed' || g, 'owner' || (g % $1) || '@example.test', 'Store ' || g, 'completed', 'test-model', 3,
                now() - (g * interval '1 second')
           FROM generate_series(1, $2) g`,
        [OWNERS, ROWS],
      );
      await pool.query(
        `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
         SELECT 'file-seed' || g, 'owner' || (g % $1) || '@example.test', 'f' || g || '.txt', 'assistants', $3, 4,
                now() - (g * interval '1 second')
           FROM generate_series(1, $2) g`,
        [OWNERS, ROWS, sha256Of(blob)],
      );
      // Every store holds files; one in fifty attachments failed.
      await pool.query(
        `INSERT INTO vector_store_files (store_id, file_id, status, created_at)
         SELECT 'vs_seed' || g, 'file-seed' || g, CASE WHEN g % 50 = 0 THEN 'failed' ELSE 'completed' END,
                now() - (g * interval '1 second')
           FROM generate_series(1, $1) g`,
        [ROWS],
      );
      await pool.query('ANALYZE vector_stores; ANALYZE fs_files; ANALYZE vector_store_files');
    });

    /** Runs `call`, captures the one statement it sends, and returns that statement's plan. */
    async function planOf(call: () => Promise<unknown>): Promise<string> {
      const spy = jest.spyOn(pool, 'query');
      let sent: [string, unknown[]];
      try {
        await call();
        sent = spy.mock.calls[0] as unknown as [string, unknown[]];
      } finally {
        spy.mockRestore();
      }
      const [text, params] = sent;
      const { rows } = await pool.query(`EXPLAIN ${text}`, params);
      return rows.map((r: any) => r['QUERY PLAN']).join('\n');
    }

    it('the all-owner store and file lists walk the (created_at, id) indexes, first page and next page alike', async () => {
      const storesPlan = await planOf(() => admin.listAllStores({ limit: 20 }));
      expect(storesPlan).toContain('Index Scan Backward using idx_vector_stores_created');
      expect(storesPlan).not.toMatch(/Seq Scan on vector_stores|Sort/);

      const storesNext = await planOf(() => admin.listAllStores({ limit: 20, after: 'vs_seed100' }));
      expect(storesNext).toContain('idx_vector_stores_created');
      expect(storesNext).not.toMatch(/Seq Scan|Sort/);

      const filesPlan = await planOf(() => admin.listAllFiles({ limit: 20 }));
      expect(filesPlan).toContain('Index Scan Backward using idx_fs_files_created');
      // The per-row attachment count looks the file up by file_id, not by scanning.
      expect(filesPlan).toContain('idx_vsf_file');
      expect(filesPlan).not.toMatch(/Seq Scan|Sort/);

      const filesNext = await planOf(() => admin.listAllFiles({ limit: 20, after: 'file-seed100' }));
      expect(filesNext).toContain('idx_fs_files_created');
      expect(filesNext).not.toMatch(/Seq Scan|Sort/);
    });

    it('the failed list walks its partial index, and the overview never touches the chunks', async () => {
      const failedPlan = await planOf(() => admin.listFailedAttachments({ limit: 20 }));
      expect(failedPlan).toContain('idx_vsf_failed');
      expect(failedPlan).not.toMatch(/Seq Scan on vector_store_files|Sort/);

      const overviewPlan = await planOf(() => admin.overview(TARGET));
      expect(overviewPlan).not.toContain('vector_store_chunks');
    });
  });
});

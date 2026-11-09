// Vector-store FILE BATCH primitives, against a real Postgres database.
//
// These properties cannot be demonstrated against a mock, because every one of
// them IS the SQL: status and file_counts are derived by an aggregate query
// over the member rows rather than stored (so a mock returning canned counts
// would prove nothing), the tenant boundary is a `store_id` predicate inside
// each statement (so a mock that ignores the predicate would pass), and
// createBatch's partial-failure rollback depends on a real unique-violation
// from a real constraint.
//
// Each test below is named so a mutation can be tied to the one test that
// catches it. The three that matter most:
//   - "derives cancelled ONLY when ..."  catches reordering deriveBatchStatus's
//     first two rules (cancellation requested wins over a running member).
//   - "counts only its own batch ..."    catches dropping `f.batch_id = b.id`
//     from the counts join (a sibling batch's files leak in).
//   - "getBatch returns null for a batch belonging to another store"
//                                        catches dropping `store_id` from
//     getBatch's predicate — the tenant boundary.
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { sha256Of, retainBlob } from '../../../src/fileSearch/blob/blobStore';
import { newFileId, newBatchId } from '../../../src/fileSearch/ids';
import * as repo from '../../../src/fileSearch/repository';
import {
  createBatch,
  getBatch,
  batchStatusAndCounts,
  requestBatchCancel,
  listBatchFiles,
} from '../../../src/fileSearch/batches';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const OWNER = 'batches-owner@example.com';

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

d('vector store file batches against a real Postgres database (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  beforeAll(async () => {
    // Set BEFORE runMigration -- buildSchemaSql reads embeddingDimensions.
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
    await pool.query('DELETE FROM vector_store_chunks');
    await pool.query('DELETE FROM vector_store_batches');
    await pool.query('DELETE FROM vector_store_files');
    await pool.query('DELETE FROM vector_stores');
    await pool.query('DELETE FROM fs_files');
    await pool.query('DELETE FROM file_blobs');
  });

  async function seedFile(filename: string): Promise<string> {
    const content = Buffer.from(`${filename}:${crypto.randomBytes(6).toString('hex')}`);
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

  async function seedStore(): Promise<string> {
    const store = await repo.createStore({ ownerEmail: OWNER });
    return store.id;
  }

  /** Advances one member file's status the way the ingestion worker would.
   *  Nothing in `batches.ts` writes per-file status; the worker owns that. */
  async function markFileStatus(storeId: string, fileId: string, status: string): Promise<void> {
    const result = await pool.query(
      'UPDATE vector_store_files SET status = $3 WHERE store_id = $1 AND file_id = $2',
      [storeId, fileId, status],
    );
    // Guards the helper itself: a typo'd id would otherwise silently update
    // nothing and leave the test asserting against the pre-seeded state.
    expect(result.rowCount).toBe(1);
  }

  async function batchIdsOf(storeId: string): Promise<Array<string | null>> {
    const { rows } = await pool.query<{ batch_id: string | null }>(
      'SELECT batch_id FROM vector_store_files WHERE store_id = $1 ORDER BY file_id', [storeId],
    );
    return rows.map((r) => r.batch_id);
  }

  // -----------------------------------------------------------------------
  // ids
  // -----------------------------------------------------------------------

  it('mints batch ids as vsfb_ plus 24 lowercase hex characters, distinct per call', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const id = newBatchId();
      expect(id).toMatch(/^vsfb_[0-9a-f]{24}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(200);
  });

  // -----------------------------------------------------------------------
  // createBatch / membership
  // -----------------------------------------------------------------------

  it('creates a batch and stamps batch_id on every member file', async () => {
    const storeId = await seedStore();
    const fileA = await seedFile('a.txt');
    const fileB = await seedFile('b.txt');

    const batch = await createBatch(storeId, [fileA, fileB], null, null);

    expect(batch.id).toMatch(/^vsfb_[0-9a-f]{24}$/);
    expect(batch.store_id).toBe(storeId);
    expect(batch.cancel_requested).toBe(false);
    expect(batch.created_at).toBeInstanceOf(Date);

    const stamped = await batchIdsOf(storeId);
    expect(stamped).toHaveLength(2);
    expect(stamped.every((b) => b === batch.id)).toBe(true);
  });

  it('attaches member files as in_progress so the ingestion worker picks them up', async () => {
    const storeId = await seedStore();
    const fileA = await seedFile('a.txt');
    await createBatch(storeId, [fileA], null, null);

    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM vector_store_files WHERE store_id = $1', [storeId],
    );
    expect(rows.map((r) => r.status)).toEqual(['in_progress']);
  });

  it('applies the batch attributes and chunking strategy to every member file', async () => {
    const storeId = await seedStore();
    const fileA = await seedFile('a.txt');
    const fileB = await seedFile('b.txt');

    await createBatch(storeId, [fileA, fileB], { topic: 'quarterly' }, { type: 'static', max_chunk_size_tokens: 400 });

    const { rows } = await pool.query<{ attributes: any; chunking_strategy: any }>(
      'SELECT attributes, chunking_strategy FROM vector_store_files WHERE store_id = $1', [storeId],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.attributes).toEqual({ topic: 'quarterly' });
      expect(row.chunking_strategy).toEqual({ type: 'static', max_chunk_size_tokens: 400 });
    }
  });

  it('leaves batch_id null for a plain single-file attach (attachFile default is unchanged)', async () => {
    const storeId = await seedStore();
    const fileA = await seedFile('a.txt');

    // Exactly the call the single-file HTTP path already makes -- four args.
    const vsf = await repo.attachFile(storeId, fileA, {});

    expect(vsf.batch_id).toBeNull();
    expect(await batchIdsOf(storeId)).toEqual([null]);
  });

  it('slides the store last_active_at forward when a batch attaches files', async () => {
    const storeId = await seedStore();
    await pool.query("UPDATE vector_stores SET last_active_at = now() - interval '1 day' WHERE id = $1", [storeId]);
    const before = (await pool.query('SELECT last_active_at FROM vector_stores WHERE id = $1', [storeId])).rows[0]
      .last_active_at as Date;

    await createBatch(storeId, [await seedFile('a.txt')], null, null);

    const after = (await pool.query('SELECT last_active_at FROM vector_stores WHERE id = $1', [storeId])).rows[0]
      .last_active_at as Date;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('rolls the whole batch back when one attach fails partway through', async () => {
    const storeId = await seedStore();
    const fileA = await seedFile('a.txt');
    const fileB = await seedFile('b.txt');

    // fileA twice: the second attach violates the (store_id, file_id) primary
    // key, after fileA and fileB have already been attached.
    await expect(createBatch(storeId, [fileA, fileB, fileA], null, null)).rejects.toMatchObject({ code: '23505' });

    const files = await pool.query('SELECT file_id FROM vector_store_files WHERE store_id = $1', [storeId]);
    expect(files.rowCount).toBe(0);
    const batches = await pool.query('SELECT id FROM vector_store_batches WHERE store_id = $1', [storeId]);
    expect(batches.rowCount).toBe(0);
  });

  it('refuses to create a batch against a store that does not exist', async () => {
    await expect(createBatch('vs_ffffffffffffffffffffffff', [], null, null)).rejects.toMatchObject({ code: '23503' });
  });

  // -----------------------------------------------------------------------
  // Status derivation -- the load-bearing rules
  // -----------------------------------------------------------------------

  it('derives in_progress while any member file is still in_progress', async () => {
    const storeId = await seedStore();
    const fileA = await seedFile('a.txt');
    const fileB = await seedFile('b.txt');
    const batch = await createBatch(storeId, [fileA, fileB], null, null);

    await markFileStatus(storeId, fileA, 'completed');

    const result = await batchStatusAndCounts(storeId, batch.id);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('in_progress');
    expect(result!.file_counts).toEqual({ in_progress: 1, completed: 1, failed: 0, cancelled: 0, total: 2 });
  });

  it('derives completed once nothing is in_progress, even with a failed member', async () => {
    const storeId = await seedStore();
    const fileA = await seedFile('a.txt');
    const fileB = await seedFile('b.txt');
    const batch = await createBatch(storeId, [fileA, fileB], null, null);

    await markFileStatus(storeId, fileA, 'completed');
    await markFileStatus(storeId, fileB, 'failed');

    const result = await batchStatusAndCounts(storeId, batch.id);
    // OpenAI reports the batch as completed; the failure shows up in the counts.
    expect(result!.status).toBe('completed');
    expect(result!.file_counts).toEqual({ in_progress: 0, completed: 1, failed: 1, cancelled: 0, total: 2 });
  });

  it('derives cancelled ONLY when cancellation was requested AND nothing is still running', async () => {
    const storeId = await seedStore();
    const fileA = await seedFile('a.txt');
    const fileB = await seedFile('b.txt');
    const batch = await createBatch(storeId, [fileA, fileB], null, null);

    expect(await requestBatchCancel(storeId, batch.id)).toBe(true);

    // Both members still in_progress: the worker has not stopped, so neither
    // has the batch. Reporting `cancelled` here would tell an SDK client
    // polling createAndPoll that a still-mutating store had settled.
    expect((await batchStatusAndCounts(storeId, batch.id))!.status).toBe('in_progress');

    await markFileStatus(storeId, fileA, 'cancelled');
    // One member still running -- still not terminal.
    expect((await batchStatusAndCounts(storeId, batch.id))!.status).toBe('in_progress');

    await markFileStatus(storeId, fileB, 'cancelled');
    const settled = await batchStatusAndCounts(storeId, batch.id);
    expect(settled!.status).toBe('cancelled');
    expect(settled!.file_counts).toEqual({ in_progress: 0, completed: 0, failed: 0, cancelled: 2, total: 2 });
  });

  it('derives cancelled even when the members that stopped had already completed', async () => {
    const storeId = await seedStore();
    const fileA = await seedFile('a.txt');
    const batch = await createBatch(storeId, [fileA], null, null);

    await markFileStatus(storeId, fileA, 'completed');
    await requestBatchCancel(storeId, batch.id);

    expect((await batchStatusAndCounts(storeId, batch.id))!.status).toBe('cancelled');
  });

  it('never derives failed, whatever the mix of member outcomes', async () => {
    const storeId = await seedStore();
    const fileA = await seedFile('a.txt');
    const fileB = await seedFile('b.txt');
    const fileC = await seedFile('c.txt');
    const batch = await createBatch(storeId, [fileA, fileB, fileC], null, null);

    await markFileStatus(storeId, fileA, 'failed');
    await markFileStatus(storeId, fileB, 'failed');
    await markFileStatus(storeId, fileC, 'cancelled');

    const result = await batchStatusAndCounts(storeId, batch.id);
    expect(result!.status).toBe('completed');
    expect(result!.file_counts).toEqual({ in_progress: 0, completed: 0, failed: 2, cancelled: 1, total: 3 });
  });

  it('keeps the four buckets summing to total when a member carries an unexpected status', async () => {
    const storeId = await seedStore();
    const fileA = await seedFile('a.txt');
    const fileB = await seedFile('b.txt');
    const batch = await createBatch(storeId, [fileA, fileB], null, null);

    await markFileStatus(storeId, fileA, 'completed');
    // vector_store_files.status has no CHECK constraint, so a future writer
    // could emit a fifth value. Written raw here because no code path can
    // produce one today -- which is the point: file_counts is a fixed five-key
    // object whose four buckets are expected to sum to `total`, and an
    // unbucketed row must not silently inflate `total` and break that
    // arithmetic on the wire, nor add a sixth key and break the shape.
    await markFileStatus(storeId, fileB, 'quarantined');

    const result = await batchStatusAndCounts(storeId, batch.id);
    expect(result!.file_counts).toEqual({ in_progress: 0, completed: 1, failed: 0, cancelled: 0, total: 1 });
    const { in_progress, completed, failed, cancelled, total } = result!.file_counts;
    expect(in_progress + completed + failed + cancelled).toBe(total);
    expect(Object.keys(result!.file_counts).sort())
      .toEqual(['cancelled', 'completed', 'failed', 'in_progress', 'total']);
  });

  it('reports an empty batch as completed with all-zero counts', async () => {
    const storeId = await seedStore();
    const batch = await createBatch(storeId, [], null, null);

    const result = await batchStatusAndCounts(storeId, batch.id);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('completed');
    expect(result!.file_counts).toEqual({ in_progress: 0, completed: 0, failed: 0, cancelled: 0, total: 0 });
  });

  // -----------------------------------------------------------------------
  // Counts are scoped to the batch
  // -----------------------------------------------------------------------

  it('counts only its own batch, never a sibling batch in the same store', async () => {
    const storeId = await seedStore();
    const fileA = await seedFile('a.txt');
    const fileB = await seedFile('b.txt');
    const fileC = await seedFile('c.txt');

    const one = await createBatch(storeId, [fileA], null, null);
    const two = await createBatch(storeId, [fileB, fileC], null, null);

    // Distinct per-status distributions, so a leak between them cannot be
    // masked by the two batches happening to look alike.
    await markFileStatus(storeId, fileA, 'completed');
    await markFileStatus(storeId, fileB, 'failed');

    const first = await batchStatusAndCounts(storeId, one.id);
    expect(first!.file_counts).toEqual({ in_progress: 0, completed: 1, failed: 0, cancelled: 0, total: 1 });
    expect(first!.status).toBe('completed');

    const second = await batchStatusAndCounts(storeId, two.id);
    expect(second!.file_counts).toEqual({ in_progress: 1, completed: 0, failed: 1, cancelled: 0, total: 2 });
    expect(second!.status).toBe('in_progress');
  });

  it('ignores files attached to the same store outside any batch', async () => {
    const storeId = await seedStore();
    const batched = await seedFile('a.txt');
    const loose = await seedFile('b.txt');

    const batch = await createBatch(storeId, [batched], null, null);
    await repo.attachFile(storeId, loose, {});

    expect((await batchStatusAndCounts(storeId, batch.id))!.file_counts.total).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Tenant boundary -- every query scoped by store_id, not by id entropy
  // -----------------------------------------------------------------------

  it('getBatch returns the batch for its own store', async () => {
    const storeId = await seedStore();
    const batch = await createBatch(storeId, [], null, null);

    const found = await getBatch(storeId, batch.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(batch.id);
    expect(found!.store_id).toBe(storeId);
  });

  it('getBatch returns null for a batch belonging to another store', async () => {
    const storeId = await seedStore();
    const otherStoreId = await seedStore();
    const batch = await createBatch(storeId, [await seedFile('a.txt')], null, null);

    // A vsfb_ id is unguessable, but unguessability is not authorization: the
    // store_id predicate is what makes another tenant's batch indistinguishable
    // from one that never existed.
    expect(await getBatch(otherStoreId, batch.id)).toBeNull();
  });

  it('getBatch returns null for an id that was never minted', async () => {
    const storeId = await seedStore();
    expect(await getBatch(storeId, newBatchId())).toBeNull();
  });

  it('batchStatusAndCounts returns null for a batch belonging to another store', async () => {
    const storeId = await seedStore();
    const otherStoreId = await seedStore();
    const batch = await createBatch(storeId, [await seedFile('a.txt')], null, null);

    expect(await batchStatusAndCounts(otherStoreId, batch.id)).toBeNull();
    expect(await batchStatusAndCounts(storeId, newBatchId())).toBeNull();
  });

  it('listBatchFiles returns nothing for a batch belonging to another store', async () => {
    const storeId = await seedStore();
    const otherStoreId = await seedStore();
    const batch = await createBatch(storeId, [await seedFile('a.txt')], null, null);

    expect(await listBatchFiles(otherStoreId, batch.id, { limit: 20, order: 'desc' })).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // requestBatchCancel
  // -----------------------------------------------------------------------

  it('requestBatchCancel latches the flag and is idempotent', async () => {
    const storeId = await seedStore();
    const batch = await createBatch(storeId, [], null, null);

    expect(await requestBatchCancel(storeId, batch.id)).toBe(true);
    expect((await getBatch(storeId, batch.id))!.cancel_requested).toBe(true);
    expect(await requestBatchCancel(storeId, batch.id)).toBe(true);
    expect((await getBatch(storeId, batch.id))!.cancel_requested).toBe(true);
  });

  it('requestBatchCancel returns false for an unknown batch or another store', async () => {
    const storeId = await seedStore();
    const otherStoreId = await seedStore();
    const batch = await createBatch(storeId, [], null, null);

    expect(await requestBatchCancel(storeId, newBatchId())).toBe(false);
    expect(await requestBatchCancel(otherStoreId, batch.id)).toBe(false);
    // and the real batch was not touched by the cross-store attempt
    expect((await getBatch(storeId, batch.id))!.cancel_requested).toBe(false);
  });

  it('requestBatchCancel does not rewrite member file statuses -- the worker owns those', async () => {
    const storeId = await seedStore();
    const fileA = await seedFile('a.txt');
    const batch = await createBatch(storeId, [fileA], null, null);

    await requestBatchCancel(storeId, batch.id);

    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM vector_store_files WHERE store_id = $1', [storeId],
    );
    expect(rows.map((r) => r.status)).toEqual(['in_progress']);
  });

  // -----------------------------------------------------------------------
  // listBatchFiles
  // -----------------------------------------------------------------------

  it('listBatchFiles returns only the batch members, not the whole store', async () => {
    const storeId = await seedStore();
    const mine = await seedFile('a.txt');
    const sibling = await seedFile('b.txt');
    const loose = await seedFile('c.txt');

    const batch = await createBatch(storeId, [mine], null, null);
    await createBatch(storeId, [sibling], null, null);
    await repo.attachFile(storeId, loose, {});

    const rows = await listBatchFiles(storeId, batch.id, { limit: 20, order: 'desc' });
    expect(rows.map((r) => r.file_id)).toEqual([mine]);
    expect(rows[0].batch_id).toBe(batch.id);
  });

  it('listBatchFiles filters by member file status', async () => {
    const storeId = await seedStore();
    const fileA = await seedFile('a.txt');
    const fileB = await seedFile('b.txt');
    const batch = await createBatch(storeId, [fileA, fileB], null, null);
    await markFileStatus(storeId, fileA, 'completed');

    const done = await listBatchFiles(storeId, batch.id, { limit: 20, order: 'desc', filter: 'completed' });
    expect(done.map((r) => r.file_id)).toEqual([fileA]);

    const running = await listBatchFiles(storeId, batch.id, { limit: 20, order: 'desc', filter: 'in_progress' });
    expect(running.map((r) => r.file_id)).toEqual([fileB]);
  });

  it('listBatchFiles fetches limit + 1 rows so the caller can compute has_more', async () => {
    const storeId = await seedStore();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await seedFile(`f${i}.txt`));
    const batch = await createBatch(storeId, ids, null, null);

    // 5 members, limit 2 -> 3 rows back: the page plus the lookahead row.
    expect(await listBatchFiles(storeId, batch.id, { limit: 2, order: 'asc' })).toHaveLength(3);
    // 5 members, limit 10 -> all 5, no lookahead available.
    expect(await listBatchFiles(storeId, batch.id, { limit: 10, order: 'asc' })).toHaveLength(5);
  });

  it('listBatchFiles paginates forward with after and backward with before', async () => {
    const storeId = await seedStore();
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) ids.push(await seedFile(`f${i}.txt`));
    const batch = await createBatch(storeId, ids, null, null);

    const ascending = (await listBatchFiles(storeId, batch.id, { limit: 10, order: 'asc' })).map((r) => r.file_id);
    expect(ascending).toHaveLength(4);

    const afterFirst = await listBatchFiles(storeId, batch.id, { limit: 10, order: 'asc', after: ascending[0] });
    expect(afterFirst.map((r) => r.file_id)).toEqual(ascending.slice(1));

    // `before` fetches in the reversed direction (the caller reverses the
    // trimmed page); as a set it is everything strictly before the cursor.
    const beforeLast = await listBatchFiles(storeId, batch.id, { limit: 10, order: 'asc', before: ascending[3] });
    expect(beforeLast.map((r) => r.file_id).sort()).toEqual(ascending.slice(0, 3).sort());
  });

  it('listBatchFiles yields an empty page for a cursor that is not a member of the batch', async () => {
    const storeId = await seedStore();
    const mine = await seedFile('a.txt');
    const sibling = await seedFile('b.txt');
    const batch = await createBatch(storeId, [mine], null, null);
    await createBatch(storeId, [sibling], null, null);

    expect(await listBatchFiles(storeId, batch.id, { limit: 20, order: 'asc', after: sibling })).toEqual([]);
    expect(await listBatchFiles(storeId, batch.id, { limit: 20, order: 'asc', after: newFileId() })).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  it('deleting the store removes its batch rows via the foreign key cascade', async () => {
    const storeId = await seedStore();
    const batch = await createBatch(storeId, [await seedFile('a.txt')], null, null);

    expect(await repo.deleteStoreCascade(storeId, OWNER)).toEqual({ deleted: true });

    const { rows } = await pool.query('SELECT id FROM vector_store_batches WHERE id = $1', [batch.id]);
    expect(rows).toHaveLength(0);
  });
});

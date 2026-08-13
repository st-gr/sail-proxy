// All four `/vector_stores/{id}/file_batches` endpoints — create, retrieve,
// cancel and list-files — the HTTP layer over Task 1's batch primitives.
//
// AGAINST A REAL POSTGRES DATABASE, deliberately. Everything these
// handlers are actually responsible for is a property OF the data they read
// back: `status`/`file_counts` are DERIVED by an aggregate over the member
// rows (a mock returning canned counts would prove nothing about the object on
// the wire), the cross-store 404 is a `store_id` predicate inside
// `batches.ts`'s statements (a mock that ignores predicates passes either
// way), and the file-ownership oracle check needs two real owners' rows to be
// indistinguishable.
//
// That is why this suite lives HERE and not beside the mocked-pool
// `test/fileSearch/vectorStoresController.test.ts`, which is this file's
// unit-level counterpart for the same controller. Every DSN-gated suite is in
// this directory, sharing `schemaFixture.ts`'s per-suite schema isolation and
// this directory's skip convention — a DB-backed suite outside it is one a
// reader has no reason to suspect needs a database.
//
// THE DB-BACKED SUITE SKIPS without FILE_SEARCH_TEST_DSN, and says so loudly
// below: a run that never set it reports a smaller green number that has
// verified nothing about either endpoint. The route-registration block at the
// bottom needs no database and deliberately runs either way — it is the one
// check here that must never be silently skippable.
//
// Each test is named so a mutation can be tied to the one test that catches
// it. The ones that matter most:
//   - "created_at is Unix seconds ..."          catches emitting milliseconds
//     (or an ISO string) — invisible to curl, fatal to every SDK client.
//   - "404s a batch id from another store ..."  catches dropping the store_id
//     scope from the retrieve path.
//   - "404s a batch id that does not exist ..." catches dropping retrieve's
//     null check, which would render a missing batch as an empty completed
//     one — indistinguishable, on the wire, from the genuinely empty batch
//     asserted by "reports an empty batch as completed with zero counts".
//   - "lists only the files in that batch ..."  catches dropping the batch_id
//     filter from the list query, which leaks a sibling batch's files.
//   - "404s a cancel for a batch that belongs to another store, and leaves
//     that batch's flag unset" catches dropping the store_id scope from the
//     cancel UPDATE — a mutation the STATUS CODE cannot see (see the test).
//   - "paginates with the store file list's cursor contract ..." and "reports
//     has_more false on a final page that is exactly full" together catch an
//     inverted or length-guessed `has_more`.
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { sha256Of, retainBlob } from '../../../src/fileSearch/blob/blobStore';
import { newFileId, newBatchId } from '../../../src/fileSearch/ids';
import * as repo from '../../../src/fileSearch/repository';
import { createBatch } from '../../../src/fileSearch/batches';
import * as ctrl from '../../../src/controllers/vectorStoresController';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

if (!DSN) {
  // Announce the skip loudly, matching teacherLogging.test.ts. This is the ONLY
  // suite that exercises the four file-batch handlers at all: their derived
  // `file_counts`, their `store_id`-scoped 404s, their `batch_id`-scoped file
  // list and their file-ownership non-oracle are all properties of real rows,
  // so a missing DSN turns a green run into one that has verified nothing about
  // any of the endpoints — while still reporting a plausible-looking pass. (The
  // route-registration block below still runs; the behavioural tests are lost.)
  // eslint-disable-next-line no-console
  console.warn(
    '[batchesController.test.ts] SKIPPED — FILE_SEARCH_TEST_DSN is not set. '
    + 'The four /vector_stores/{id}/file_batches endpoints (create, retrieve, cancel, '
    + 'list files) are NOT covered by this run; no test anywhere else exercises them.',
  );
}

const EMBED_DIM = 3;
const OWNER = 'batch-controller-owner@example.com';
const OTHER = 'batch-controller-other@example.com';

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

function baseConfig(maxFilesPerStore = 10000): any {
  return {
    enabled: true,
    embeddingModel: 'test-model',
    embeddingDimensions: EMBED_DIM,
    limits: { maxFilesPerStore },
    blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
  };
}

function makeRes(): any {
  const res: any = { headersSent: false, statusCode: 200 };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  res.set = (...args: any[]) => { res.headers = res.headers ?? {}; res.headers[args[0]] = args[1]; return res; };
  res.send = (body: any) => { res.body = body; return res; };
  return res;
}

function baseReq(email: string, overrides: Record<string, any> = {}): any {
  return { headers: {}, params: {}, query: {}, body: {}, apiKeyInfo: { email }, ...overrides };
}

/** Any call to `next` here is an unhandled 500 in production — surfaced as a
 *  test failure rather than silently swallowed. */
const throwOnError = (e: any) => { throw e; };

d('vector-store file-batch endpoints against a real Postgres database (requires FILE_SEARCH_TEST_DSN)', () => {
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
    await pool.query('DELETE FROM vector_store_files');
    await pool.query('DELETE FROM vector_store_batches');
    await pool.query('DELETE FROM vector_stores');
    await pool.query('DELETE FROM fs_files');
    await pool.query('DELETE FROM file_blobs');
  });

  async function seedFile(ownerEmail: string, filename: string): Promise<string> {
    const content = Buffer.from(`contents of ${filename} for ${ownerEmail}`);
    const sha = sha256Of(content);
    await retainBlob(sha, content, 'text/plain');
    const id = newFileId();
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
       VALUES ($1,$2,$3,'assistants',$4,$5, now())`,
      [id, ownerEmail, filename, sha, content.length],
    );
    return id;
  }

  async function createBatchViaHttp(
    storeId: string, body: Record<string, unknown>, email = OWNER,
  ): Promise<any> {
    const res = makeRes();
    await ctrl.createVectorStoreFileBatch(baseReq(email, { params: { id: storeId }, body }), res, throwOnError);
    return res;
  }

  async function retrieveBatchViaHttp(storeId: string, batchId: string, email = OWNER): Promise<any> {
    const res = makeRes();
    await ctrl.retrieveVectorStoreFileBatch(
      baseReq(email, { params: { id: storeId, batch_id: batchId } }), res, throwOnError,
    );
    return res;
  }

  async function cancelBatchViaHttp(storeId: string, batchId: string, email = OWNER): Promise<any> {
    const res = makeRes();
    await ctrl.cancelVectorStoreFileBatch(
      baseReq(email, { params: { id: storeId, batch_id: batchId } }), res, throwOnError,
    );
    return res;
  }

  async function listBatchFilesViaHttp(
    storeId: string, batchId: string, query: Record<string, unknown> = {}, email = OWNER,
  ): Promise<any> {
    const res = makeRes();
    await ctrl.listVectorStoreFileBatchFiles(
      baseReq(email, { params: { id: storeId, batch_id: batchId }, query }), res, throwOnError,
    );
    return res;
  }

  /** Reads the raw flag `requestBatchCancel` writes. Asserted directly because
   *  the RESPONSE cannot show it: the emitted `status` is derived from the
   *  member files, so a cancel that set the flag on a batch in the WRONG store
   *  still renders a perfectly plausible object — and still 404s, because the
   *  read-back is store-scoped. The row is the only witness. */
  async function cancelRequestedFlag(batchId: string): Promise<boolean | undefined> {
    const { rows } = await pool.query<{ cancel_requested: boolean }>(
      'SELECT cancel_requested FROM vector_store_batches WHERE id = $1', [batchId],
    );
    return rows[0]?.cancel_requested;
  }

  /**
   * Gives each member file a distinct `created_at`, one second apart, in the
   * order given.
   *
   * `attachFile` stamps `created_at` from a JS `new Date()` inside a loop, so
   * two members of one batch can land in the SAME millisecond — at which point
   * the `(created_at, file_id)` tiebreak, not insertion order, decides the page
   * order, and every ordering expectation below would depend on how fast the
   * machine ran. Fixing the timestamps makes the expected order a property of
   * the fixture: ascending is `fileIds`, descending is its reverse, everywhere.
   */
  async function spaceOutCreatedAt(storeId: string, fileIds: string[]): Promise<void> {
    for (const [index, fileId] of fileIds.entries()) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        'UPDATE vector_store_files SET created_at = $1 WHERE store_id = $2 AND file_id = $3',
        [new Date(Date.UTC(2026, 0, 1, 12, 0, index)), storeId, fileId],
      );
    }
  }

  // -------------------------------------------------------------------------
  // POST /vector_stores/{id}/file_batches — the OpenAI object
  // -------------------------------------------------------------------------
  describe('createVectorStoreFileBatch — response object', () => {
    it('creates a batch and returns the OpenAI vector_store.file_batch shape', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const fileA = await seedFile(OWNER, 'a.txt');
      const fileB = await seedFile(OWNER, 'b.txt');

      const res = await createBatchViaHttp(store.id, { file_ids: [fileA, fileB] });

      expect(res.statusCode).toBe(200);
      expect(res.body.object).toBe('vector_store.file_batch');
      expect(res.body.id).toMatch(/^vsfb_/);
      expect(res.body.vector_store_id).toBe(store.id);
      expect(res.body.status).toBe('in_progress');
      expect(res.body.file_counts).toEqual({
        in_progress: 2, completed: 0, failed: 0, cancelled: 0, total: 2,
      });
      // OpenAI's object is exactly these six keys — an extra one (a leaked
      // internal such as `cancel_requested`) is a wire-contract change.
      expect(Object.keys(res.body).sort()).toEqual(
        ['created_at', 'file_counts', 'id', 'object', 'status', 'vector_store_id'],
      );
    });

    it('created_at is Unix seconds, not milliseconds and not an ISO string', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const fileA = await seedFile(OWNER, 'a.txt');

      const res = await createBatchViaHttp(store.id, { file_ids: [fileA] });
      expect(res.statusCode).toBe(200);

      // Exact equality against the stored timestamp: a milliseconds value is
      // 1000x too large and an ISO string is not a number, so both fail here
      // AND on the bound below. The bound is kept as a standalone tripwire
      // because it fails even if the row itself were ever mis-stored.
      const { rows } = await pool.query<{ created_at: Date }>(
        'SELECT created_at FROM vector_store_batches WHERE id = $1', [res.body.id],
      );
      expect(typeof res.body.created_at).toBe('number');
      expect(Number.isInteger(res.body.created_at)).toBe(true);
      expect(res.body.created_at).toBe(Math.floor(rows[0].created_at.getTime() / 1000));
      expect(res.body.created_at).toBeLessThan(2_000_000_000);
      expect(res.body.created_at).toBeGreaterThan(1_600_000_000);
    });

    it('stamps every member file with the batch id and leaves them in_progress for the worker', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const fileA = await seedFile(OWNER, 'a.txt');
      const fileB = await seedFile(OWNER, 'b.txt');

      const res = await createBatchViaHttp(store.id, { file_ids: [fileA, fileB] });
      expect(res.statusCode).toBe(200);

      const { rows } = await pool.query<{ file_id: string; batch_id: string; status: string }>(
        'SELECT file_id, batch_id, status FROM vector_store_files WHERE store_id = $1 ORDER BY file_id', [store.id],
      );
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.batch_id === res.body.id)).toBe(true);
      expect(rows.every((r) => r.status === 'in_progress')).toBe(true);
    });

    it('passes attributes and chunking_strategy through to the member rows', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const fileA = await seedFile(OWNER, 'a.txt');

      const res = await createBatchViaHttp(store.id, {
        file_ids: [fileA],
        attributes: { source: 'unit-test' },
        chunking_strategy: { type: 'auto' },
      });
      expect(res.statusCode).toBe(200);

      const { rows } = await pool.query<{ attributes: any; chunking_strategy: any }>(
        'SELECT attributes, chunking_strategy FROM vector_store_files WHERE store_id = $1 AND file_id = $2',
        [store.id, fileA],
      );
      expect(rows[0].attributes).toEqual({ source: 'unit-test' });
      expect(rows[0].chunking_strategy).toEqual({ type: 'auto' });
    });

    it('dedupes a repeated file_id rather than failing on the unique constraint', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const fileA = await seedFile(OWNER, 'a.txt');

      const res = await createBatchViaHttp(store.id, { file_ids: [fileA, fileA] });
      expect(res.statusCode).toBe(200);
      expect(res.body.file_counts.total).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // POST — request validation
  // -------------------------------------------------------------------------
  describe('createVectorStoreFileBatch — request validation', () => {
    it('rejects an empty file_ids array with 400', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const res = await createBatchViaHttp(store.id, { file_ids: [] });
      expect(res.statusCode).toBe(400);
      expect(res.body.error.type).toBe('invalid_request_error');
      expect(res.body.error.code).toBe('invalid_file_ids');
    });

    it('rejects a missing file_ids field with the same 400 as an empty array', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const res = await createBatchViaHttp(store.id, {});
      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('invalid_file_ids');
    });

    it('rejects a non-array file_ids with 400', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const res = await createBatchViaHttp(store.id, { file_ids: 'file-1' });
      expect(res.statusCode).toBe(400);
      expect(res.body.error.type).toBe('invalid_request_error');
    });

    it('creates nothing at all when validation rejects the request', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const res = await createBatchViaHttp(store.id, { file_ids: ['file-does-not-exist'] });
      expect(res.statusCode).toBe(400);

      const batches = await pool.query('SELECT id FROM vector_store_batches');
      const files = await pool.query('SELECT file_id FROM vector_store_files');
      expect(batches.rows).toHaveLength(0);
      expect(files.rows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // POST — the tenant boundaries
  // -------------------------------------------------------------------------
  describe('createVectorStoreFileBatch — ownership is never an oracle', () => {
    it('rejects a file_id the caller does not own with the SAME error as an unknown one', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const theirFile = await seedFile(OTHER, 'theirs.txt');

      const unknown = await createBatchViaHttp(store.id, { file_ids: ['file-definitely-not-real'] });
      const theirs = await createBatchViaHttp(store.id, { file_ids: [theirFile] });

      // Status, error type and error code must all match: any difference lets
      // a caller enumerate which `file-` ids exist by diffing responses.
      expect(unknown.statusCode).toBe(400);
      expect(theirs.statusCode).toBe(unknown.statusCode);
      expect(theirs.body.error.type).toBe(unknown.body.error.type);
      expect(theirs.body.error.code).toBe(unknown.body.error.code);
      // The message differs only by the echoed id — the caller's own input,
      // which carries no information it did not already have.
      expect(unknown.body.error.message).toBe('No such file: file-definitely-not-real');
      expect(theirs.body.error.message).toBe(`No such file: ${theirFile}`);
    });

    it('404s a store owned by another caller, identically to a store that does not exist', async () => {
      const theirStore = await repo.createStore({ ownerEmail: OTHER, name: 'theirs' });
      const fileA = await seedFile(OWNER, 'a.txt');

      const theirs = await createBatchViaHttp(theirStore.id, { file_ids: [fileA] });
      const unknown = await createBatchViaHttp('vs_definitely-not-real', { file_ids: [fileA] });

      expect(theirs.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      expect(theirs.body.error.code).toBe(unknown.body.error.code);
      expect(theirs.body.error.type).toBe(unknown.body.error.type);

      // ...and nothing was attached to the other owner's store.
      const { rows } = await pool.query('SELECT file_id FROM vector_store_files WHERE store_id = $1', [theirStore.id]);
      expect(rows).toHaveLength(0);
    });

    it('rejects the whole batch when only ONE of several file_ids is unowned', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const mine = await seedFile(OWNER, 'mine.txt');
      const theirs = await seedFile(OTHER, 'theirs.txt');

      const res = await createBatchViaHttp(store.id, { file_ids: [mine, theirs] });
      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('file_not_found');

      // The valid file must NOT have been attached — validation runs over the
      // whole list before createBatch, so the rollback is never reached.
      const { rows } = await pool.query('SELECT file_id FROM vector_store_files WHERE store_id = $1', [store.id]);
      expect(rows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // POST — the rules the single-file attach path already enforces
  // -------------------------------------------------------------------------
  describe('createVectorStoreFileBatch — attach preconditions', () => {
    it('409s when a file in the batch is already attached to the store', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const fileA = await seedFile(OWNER, 'a.txt');
      const fileB = await seedFile(OWNER, 'b.txt');
      await repo.attachFile(store.id, fileA, {}, null);

      const res = await createBatchViaHttp(store.id, { file_ids: [fileA, fileB] });
      expect(res.statusCode).toBe(409);
      expect(res.body.error.code).toBe('file_already_attached');

      // No batch row, and fileB was never attached: rejected before createBatch
      // rather than by rolling back a partially built batch.
      const batches = await pool.query('SELECT id FROM vector_store_batches');
      expect(batches.rows).toHaveLength(0);
      const attached = await pool.query('SELECT file_id FROM vector_store_files WHERE store_id = $1', [store.id]);
      expect(attached.rows.map((r: any) => r.file_id)).toEqual([fileA]);
    });

    it('400s when the batch would push the store past maxFilesPerStore', async () => {
      mockConfig = baseConfig(2);
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const fileA = await seedFile(OWNER, 'a.txt');
      const fileB = await seedFile(OWNER, 'b.txt');
      const fileC = await seedFile(OWNER, 'c.txt');
      await repo.attachFile(store.id, fileA, {}, null);

      const res = await createBatchViaHttp(store.id, { file_ids: [fileB, fileC] });
      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('vector_store_file_limit_exceeded');

      const batches = await pool.query('SELECT id FROM vector_store_batches');
      expect(batches.rows).toHaveLength(0);
    });

    it('allows a batch that exactly fills the store to maxFilesPerStore', async () => {
      mockConfig = baseConfig(2);
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const fileA = await seedFile(OWNER, 'a.txt');
      const fileB = await seedFile(OWNER, 'b.txt');

      const res = await createBatchViaHttp(store.id, { file_ids: [fileA, fileB] });
      expect(res.statusCode).toBe(200);
      expect(res.body.file_counts.total).toBe(2);
    });

    it('409s on an expired store rather than reviving it with new attachments', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      await pool.query("UPDATE vector_stores SET status = 'expired' WHERE id = $1", [store.id]);
      const fileA = await seedFile(OWNER, 'a.txt');

      const res = await createBatchViaHttp(store.id, { file_ids: [fileA] });
      expect(res.statusCode).toBe(409);
      expect(res.body.error.code).toBe('vector_store_expired');
    });

    it('409s when the store\'s pinned embedding_dim no longer matches configuration', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const fileA = await seedFile(OWNER, 'a.txt');
      mockConfig = baseConfig();
      mockConfig.embeddingDimensions = EMBED_DIM + 1; // configuration moved on

      const res = await createBatchViaHttp(store.id, { file_ids: [fileA] });
      expect(res.statusCode).toBe(409);
      expect(res.body.error.code).toBe('embedding_dimension_mismatch');
    });
  });

  // -------------------------------------------------------------------------
  // GET /vector_stores/{id}/file_batches/{batch_id}
  // -------------------------------------------------------------------------
  describe('retrieveVectorStoreFileBatch', () => {
    it('retrieves a batch by id and returns the same object the create returned', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const fileA = await seedFile(OWNER, 'a.txt');
      const created = await createBatchViaHttp(store.id, { file_ids: [fileA] });
      expect(created.statusCode).toBe(200);

      const res = await retrieveBatchViaHttp(store.id, created.body.id);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual(created.body);
    });

    it('re-derives status and file_counts on every read rather than echoing stored ones', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const fileA = await seedFile(OWNER, 'a.txt');
      const fileB = await seedFile(OWNER, 'b.txt');
      const created = await createBatchViaHttp(store.id, { file_ids: [fileA, fileB] });

      // The worker completes one member; nothing updates the batch row.
      await pool.query(
        "UPDATE vector_store_files SET status = 'completed' WHERE store_id = $1 AND file_id = $2", [store.id, fileA],
      );
      const midway = await retrieveBatchViaHttp(store.id, created.body.id);
      expect(midway.statusCode).toBe(200);
      expect(midway.body.status).toBe('in_progress');
      expect(midway.body.file_counts).toEqual({
        in_progress: 1, completed: 1, failed: 0, cancelled: 0, total: 2,
      });

      // ...and once the last member lands, the batch is terminal.
      await pool.query(
        "UPDATE vector_store_files SET status = 'failed' WHERE store_id = $1 AND file_id = $2", [store.id, fileB],
      );
      const done = await retrieveBatchViaHttp(store.id, created.body.id);
      // A failed MEMBER does not make the BATCH 'failed' — see BatchStatus.
      expect(done.body.status).toBe('completed');
      expect(done.body.file_counts).toEqual({
        in_progress: 0, completed: 1, failed: 1, cancelled: 0, total: 2,
      });
    });

    it('counts only its own members, not a sibling batch in the same store', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const fileA = await seedFile(OWNER, 'a.txt');
      const fileB = await seedFile(OWNER, 'b.txt');
      const first = await createBatchViaHttp(store.id, { file_ids: [fileA] });
      const second = await createBatchViaHttp(store.id, { file_ids: [fileB] });

      const res = await retrieveBatchViaHttp(store.id, first.body.id);
      expect(res.body.file_counts.total).toBe(1);
      expect(res.body.id).toBe(first.body.id);
      expect(second.body.id).not.toBe(first.body.id);
    });

    it('reports an empty batch as completed with zero counts', async () => {
      // The counterpart to the 404 test below: an empty batch is a REAL,
      // retrievable resource that renders `completed` / total 0. That is
      // exactly the object a dropped null check would fabricate for a batch
      // that does not exist, which is why both tests have to exist.
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const empty = await createBatch(store.id, [], null, null);

      const res = await retrieveBatchViaHttp(store.id, empty.id);
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(res.body.file_counts).toEqual({
        in_progress: 0, completed: 0, failed: 0, cancelled: 0, total: 0,
      });
    });

    it('404s a batch id that does not exist rather than reporting an empty completed batch', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });

      const res = await retrieveBatchViaHttp(store.id, newBatchId());
      expect(res.statusCode).toBe(404);
      expect(res.body.error.type).toBe('invalid_request_error');
      expect(res.body.error.code).toBe('vector_store_file_batch_not_found');
    });

    it('404s a batch id from another store rather than leaking its existence', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 'mine' });
      const otherStore = await repo.createStore({ ownerEmail: OWNER, name: 'also mine' });
      const fileA = await seedFile(OWNER, 'a.txt');
      const created = await createBatchViaHttp(store.id, { file_ids: [fileA] });

      // Same owner, so this is purely the store_id scope — not the owner
      // check — and a 200 here would mean a `vsfb_` id resolves against any
      // store the caller can name.
      const res = await retrieveBatchViaHttp(otherStore.id, created.body.id);
      expect(res.statusCode).toBe(404);
      expect(res.body.error.code).toBe('vector_store_file_batch_not_found');
    });

    it('gives a batch from another store the identical response to one that never existed', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 'mine' });
      const otherStore = await repo.createStore({ ownerEmail: OWNER, name: 'also mine' });
      const fileA = await seedFile(OWNER, 'a.txt');
      const created = await createBatchViaHttp(store.id, { file_ids: [fileA] });

      const real = await retrieveBatchViaHttp(otherStore.id, created.body.id);
      const fake = await retrieveBatchViaHttp(otherStore.id, created.body.id.replace(/.$/, 'z'));
      expect(real.statusCode).toBe(fake.statusCode);
      expect(real.body.error.code).toBe(fake.body.error.code);
      expect(real.body.error.type).toBe(fake.body.error.type);
    });

    it('404s a real batch in a store owned by another caller, and never 403', async () => {
      const theirStore = await repo.createStore({ ownerEmail: OTHER, name: 'theirs' });
      const theirFile = await seedFile(OTHER, 'theirs.txt');
      const created = await createBatchViaHttp(theirStore.id, { file_ids: [theirFile] }, OTHER);
      expect(created.statusCode).toBe(200);

      // `getBatch` scopes by store_id, NOT by owner — without the controller's
      // own owner check this read would succeed for the wrong tenant.
      const res = await retrieveBatchViaHttp(theirStore.id, created.body.id, OWNER);
      expect(res.statusCode).toBe(404);
      expect(res.statusCode).not.toBe(403);
    });

    it('401s a request with no caller identity, before any query runs', async () => {
      const res = makeRes();
      await ctrl.retrieveVectorStoreFileBatch(
        { headers: {}, params: { id: 'vs_x', batch_id: 'vsfb_x' }, query: {}, body: {} } as any,
        res,
        throwOnError,
      );
      expect(res.statusCode).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // POST /vector_stores/{id}/file_batches/{batch_id}/cancel
  //
  // CANCEL IS A REQUEST, NOT A COMPLETION — the single most important property
  // in this block, and the one a well-meaning "fix" would break. The endpoint
  // sets `cancel_requested`; the ingestion worker is what actually stops, at
  // its next between-files check. So the batch legitimately still reads
  // `in_progress` immediately after a successful cancel, and a test asserting
  // `status === 'cancelled'` there would be pinning a lie: `cancelled` is
  // TERMINAL, and an SDK poller that sees it stops polling a store that is
  // still being written. What IS asserted right after the call is that the
  // FLAG was recorded; the status is whatever derivation says it is.
  // -------------------------------------------------------------------------
  describe('cancelVectorStoreFileBatch', () => {
    it('records the cancellation request and returns the batch object', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const fileA = await seedFile(OWNER, 'a.txt');
      const created = await createBatchViaHttp(store.id, { file_ids: [fileA] });

      const res = await cancelBatchViaHttp(store.id, created.body.id);

      expect(res.statusCode).toBe(200);
      expect(res.body.object).toBe('vector_store.file_batch');
      expect(res.body.id).toBe(created.body.id);
      expect(res.body.vector_store_id).toBe(store.id);
      // The flag is the thing this endpoint is responsible for writing.
      expect(await cancelRequestedFlag(created.body.id)).toBe(true);
    });

    it('reports the derived status, NOT cancelled, while a member file is still in_progress', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const fileA = await seedFile(OWNER, 'a.txt');
      const created = await createBatchViaHttp(store.id, { file_ids: [fileA] });

      const res = await cancelBatchViaHttp(store.id, created.body.id);

      // Not a bug and not a lag to be papered over: the worker has not run, so
      // the member is still being ingested and the batch has NOT settled.
      // Answering `cancelled` here — a terminal status — tells an SDK's
      // createAndPoll helper to stop waiting on a store still being mutated.
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('in_progress');
      expect(res.body.file_counts).toEqual({
        in_progress: 1, completed: 0, failed: 0, cancelled: 0, total: 1,
      });
      // ...and the request was still recorded, which is what makes the worker
      // stop at its next check.
      expect(await cancelRequestedFlag(created.body.id)).toBe(true);

      // A plain retrieve agrees: the status is a property of the rows, not
      // something the cancel response invented for itself.
      const after = await retrieveBatchViaHttp(store.id, created.body.id);
      expect(after.body.status).toBe('in_progress');
    });

    it('reports cancelled once the worker has left no member in_progress', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const fileA = await seedFile(OWNER, 'a.txt');
      const created = await createBatchViaHttp(store.id, { file_ids: [fileA] });

      // What the worker does when it reaches its between-files check.
      await pool.query(
        "UPDATE vector_store_files SET status = 'cancelled' WHERE store_id = $1 AND file_id = $2",
        [store.id, fileA],
      );
      const res = await cancelBatchViaHttp(store.id, created.body.id);

      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('cancelled');
      expect(res.body.file_counts).toEqual({
        in_progress: 0, completed: 0, failed: 0, cancelled: 1, total: 1,
      });
    });

    it('returns the identical object shape create and retrieve return', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const fileA = await seedFile(OWNER, 'a.txt');
      const created = await createBatchViaHttp(store.id, { file_ids: [fileA] });

      const cancelled = await cancelBatchViaHttp(store.id, created.body.id);
      const retrieved = await retrieveBatchViaHttp(store.id, created.body.id);

      // Same six keys, same values — one renderer behind all three endpoints.
      // A second, hand-rolled response object here would drift the first time
      // the batch object gains or loses a field.
      expect(Object.keys(cancelled.body).sort()).toEqual(
        ['created_at', 'file_counts', 'id', 'object', 'status', 'vector_store_id'],
      );
      expect(cancelled.body).toEqual(retrieved.body);
    });

    it('404s a cancel for a batch that belongs to another store, and leaves that batch\'s flag unset', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 'mine' });
      const otherStore = await repo.createStore({ ownerEmail: OWNER, name: 'also mine' });
      const fileA = await seedFile(OWNER, 'a.txt');
      const created = await createBatchViaHttp(store.id, { file_ids: [fileA] });

      const res = await cancelBatchViaHttp(otherStore.id, created.body.id);

      expect(res.statusCode).toBe(404);
      expect(res.body.error.code).toBe('vector_store_file_batch_not_found');
      // THE LOAD-BEARING ASSERTION. Same owner, so this is purely the
      // `store_id` scope on the UPDATE. A cancel scoped by `batch_id` alone
      // still answers 404 — the read-back that follows it is store-scoped and
      // finds nothing — so the status code cannot see that mutation at all.
      // Only the row can: the other store's ingestion would have been
      // cancelled by a caller who merely knew its batch id.
      expect(await cancelRequestedFlag(created.body.id)).toBe(false);
    });

    it('404s a cancel for a batch id that does not exist', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });

      const res = await cancelBatchViaHttp(store.id, newBatchId());
      expect(res.statusCode).toBe(404);
      expect(res.body.error.type).toBe('invalid_request_error');
      expect(res.body.error.code).toBe('vector_store_file_batch_not_found');
    });

    it('404s a real batch in a store owned by another caller, never 403, and leaves its flag unset', async () => {
      const theirStore = await repo.createStore({ ownerEmail: OTHER, name: 'theirs' });
      const theirFile = await seedFile(OTHER, 'theirs.txt');
      const created = await createBatchViaHttp(theirStore.id, { file_ids: [theirFile] }, OTHER);
      expect(created.statusCode).toBe(200);

      // `requestBatchCancel` scopes by store_id, NOT by owner — without the
      // controller's own owner check this would cancel another tenant's work.
      const res = await cancelBatchViaHttp(theirStore.id, created.body.id, OWNER);
      expect(res.statusCode).toBe(404);
      expect(res.statusCode).not.toBe(403);
      expect(await cancelRequestedFlag(created.body.id)).toBe(false);
    });

    it('404s the store itself for a store id that does not exist', async () => {
      const res = await cancelBatchViaHttp('vs_definitely-not-real', newBatchId());
      expect(res.statusCode).toBe(404);
      expect(res.body.error.code).toBe('vector_store_not_found');
    });

    it('is idempotent: a second cancel returns 200 with the same object', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const fileA = await seedFile(OWNER, 'a.txt');
      const created = await createBatchViaHttp(store.id, { file_ids: [fileA] });

      const first = await cancelBatchViaHttp(store.id, created.body.id);
      const second = await cancelBatchViaHttp(store.id, created.body.id);

      // `cancel_requested` is a one-way latch, so there is nothing to race and
      // no reason for a repeat to be an error.
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(await cancelRequestedFlag(created.body.id)).toBe(true);
    });

    it('401s a cancel with no caller identity, before any query runs', async () => {
      const res = makeRes();
      await ctrl.cancelVectorStoreFileBatch(
        { headers: {}, params: { id: 'vs_x', batch_id: 'vsfb_x' }, query: {}, body: {} } as any,
        res,
        throwOnError,
      );
      expect(res.statusCode).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // GET /vector_stores/{id}/file_batches/{batch_id}/files
  //
  // Every fixture below that claims to prove a scope has something to be
  // scoped AWAY: a sibling batch with its own members, or a file attached to
  // the store outside any batch. A list test whose store holds exactly one
  // batch cannot tell a `batch_id` filter from the absence of one, and a
  // pagination test with fewer rows than `limit` cannot tell `has_more` from
  // the constant `false`.
  // -------------------------------------------------------------------------
  describe('listVectorStoreFileBatchFiles', () => {
    it('lists only the files in that batch — not a sibling batch\'s, not an unbatched one', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const mine = await seedFile(OWNER, 'mine.txt');
      const siblingA = await seedFile(OWNER, 'sibling-a.txt');
      const siblingB = await seedFile(OWNER, 'sibling-b.txt');
      const loose = await seedFile(OWNER, 'loose.txt');
      const first = await createBatchViaHttp(store.id, { file_ids: [mine] });
      const second = await createBatchViaHttp(store.id, { file_ids: [siblingA, siblingB] });
      // Attached directly, so `batch_id` is NULL — the third thing a dropped
      // filter would sweep in.
      await repo.attachFile(store.id, loose, {}, null);

      const res = await listBatchFilesViaHttp(store.id, first.body.id);

      expect(res.statusCode).toBe(200);
      expect(res.body.object).toBe('list');
      expect(res.body.data.map((f: any) => f.id)).toEqual([mine]);

      // ...and the sibling returns its OWN two, so the assertion above is a
      // filter doing its job and not a store that happened to hold one file.
      const sibling = await listBatchFilesViaHttp(store.id, second.body.id);
      expect(sibling.body.data.map((f: any) => f.id).sort()).toEqual([siblingA, siblingB].sort());
    });

    it('emits the same vector_store.file object as the store-level file list', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const fileA = await seedFile(OWNER, 'a.txt');
      const created = await createBatchViaHttp(store.id, {
        file_ids: [fileA], attributes: { source: 'batch' }, chunking_strategy: { type: 'auto' },
      });

      const batchList = await listBatchFilesViaHttp(store.id, created.body.id);
      const storeList = makeRes();
      await ctrl.listVectorStoreFiles(baseReq(OWNER, { params: { id: store.id } }), storeList, throwOnError);

      // Identical envelope AND identical member objects: one renderer, so a
      // client that can read one endpoint can read the other.
      expect(batchList.body).toEqual(storeList.body);
      expect(batchList.body.data[0].object).toBe('vector_store.file');
      expect(batchList.body.data[0].attributes).toEqual({ source: 'batch' });
    });

    /**
     * BOTH endpoints go through ONE keyset builder — `listBatchFiles`, called
     * with the batch id here and with `null` by the store-level list — so this
     * fixture has to be able to tell the two scopes apart in BOTH directions.
     *
     * The test above cannot: its store holds one file, and that file is in the
     * batch, so a builder that ignored `batchId` entirely and a builder that
     * applied it would return the identical body. Here the store holds four
     * files, two in the batch and two attached outside it, INTERLEAVED in
     * `created_at` order — which makes each direction of drift fail loudly:
     *
     *   - a builder that IGNORES `batchId` leaks `loose0`/`loose2` into the
     *     batch list;
     *   - a builder that scopes the STORE list by `batch_id` anyway (the shape
     *     `AND ($2::text IS NULL OR batch_id = $2)` invites, and the reason
     *     this unification is a query-plan question and not a tidy-up) drops
     *     files from the store list — either the unbatched two, if the
     *     predicate binds NULL literally, or all four.
     *
     * The `after` half matters separately: the cursor lookup is the SECOND
     * statement the builder emits, scoped exactly as the page is. The
     * store-level walk resolves a cursor that happens to point at a BATCHED
     * file and must then return the unbatched file that follows it — a page
     * that silently re-scoped itself to the cursor's batch would return
     * `[member3]` and skip `loose2` outright.
     */
    it('is the store-level list narrowed to the batch — same builder, and the store list still spans files outside it', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const loose0 = await seedFile(OWNER, 'loose-0.txt');
      const member1 = await seedFile(OWNER, 'member-1.txt');
      const loose2 = await seedFile(OWNER, 'loose-2.txt');
      const member3 = await seedFile(OWNER, 'member-3.txt');

      const created = await createBatchViaHttp(store.id, { file_ids: [member1, member3] });
      // Attached directly: `batch_id` is NULL, which is what the store-level
      // list must NOT be filtering on.
      await repo.attachFile(store.id, loose0, {}, null);
      await repo.attachFile(store.id, loose2, {}, null);
      const ascending = [loose0, member1, loose2, member3];
      await spaceOutCreatedAt(store.id, ascending);

      const listStore = async (query: Record<string, unknown>): Promise<any> => {
        const res = makeRes();
        await ctrl.listVectorStoreFiles(baseReq(OWNER, { params: { id: store.id }, query }), res, throwOnError);
        return res;
      };
      const ids = (res: any): string[] => res.body.data.map((f: any) => f.id);

      const wholeStore = await listStore({ order: 'asc' });
      const justTheBatch = await listBatchFilesViaHttp(store.id, created.body.id, { order: 'asc' });

      expect(wholeStore.statusCode).toBe(200);
      expect(ids(wholeStore)).toEqual(ascending);
      expect(ids(justTheBatch)).toEqual([member1, member3]);

      // Same cursor id, two scopes: the store-level walk crosses the batch
      // boundary, the batch-level one steps over the file outside it.
      expect(ids(await listStore({ order: 'asc', after: member1 }))).toEqual([loose2, member3]);
      expect(ids(await listBatchFilesViaHttp(store.id, created.body.id, { order: 'asc', after: member1 })))
        .toEqual([member3]);

      // And the status filter still composes with the narrowing rather than
      // replacing it — `$n` numbering differs between the two scopes.
      await pool.query(
        "UPDATE vector_store_files SET status = 'completed' WHERE store_id = $1 AND file_id = ANY($2)",
        [store.id, [loose0, member1]],
      );
      expect(ids(await listStore({ order: 'asc', filter: 'completed' }))).toEqual([loose0, member1]);
      expect(ids(await listBatchFilesViaHttp(store.id, created.body.id, { order: 'asc', filter: 'completed' })))
        .toEqual([member1]);
    });

    it('paginates with the store file list\'s cursor contract: limit, has_more, first_id/last_id, after', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const files: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        files.push(await seedFile(OWNER, `p${i}.txt`));
      }
      const created = await createBatchViaHttp(store.id, { file_ids: files });
      await spaceOutCreatedAt(store.id, files);
      const expected = [...files].reverse(); // default order is desc

      const page1 = await listBatchFilesViaHttp(store.id, created.body.id, { limit: 2 });
      expect(page1.body.data.map((f: any) => f.id)).toEqual(expected.slice(0, 2));
      // Five rows, two per page: more remain. An inverted `has_more` fails
      // here AND on the last page below, which is why both are asserted.
      expect(page1.body.has_more).toBe(true);
      expect(page1.body.first_id).toBe(expected[0]);
      expect(page1.body.last_id).toBe(expected[1]);

      const page2 = await listBatchFilesViaHttp(store.id, created.body.id, { limit: 2, after: page1.body.last_id });
      expect(page2.body.data.map((f: any) => f.id)).toEqual(expected.slice(2, 4));
      expect(page2.body.has_more).toBe(true);

      const page3 = await listBatchFilesViaHttp(store.id, created.body.id, { limit: 2, after: page2.body.last_id });
      expect(page3.body.data.map((f: any) => f.id)).toEqual(expected.slice(4));
      expect(page3.body.has_more).toBe(false);
      expect(page3.body.last_id).toBe(expected[4]);

      // The walk visits every member exactly once, in order — no gap, no repeat.
      expect([...page1.body.data, ...page2.body.data, ...page3.body.data].map((f: any) => f.id)).toEqual(expected);
    });

    it('reports has_more false on a final page that is exactly full', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const files: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        files.push(await seedFile(OWNER, `f${i}.txt`));
      }
      const created = await createBatchViaHttp(store.id, { file_ids: files });
      await spaceOutCreatedAt(store.id, files);
      const expected = [...files].reverse();

      const page1 = await listBatchFilesViaHttp(store.id, created.body.id, { limit: 2 });
      const page2 = await listBatchFilesViaHttp(store.id, created.body.id, { limit: 2, after: page1.body.last_id });

      // A full last page is the case `has_more = data.length === limit` gets
      // wrong: two rows came back, and there is nothing after them.
      expect(page2.body.data.map((f: any) => f.id)).toEqual(expected.slice(2));
      expect(page2.body.has_more).toBe(false);
    });

    it('orders desc by default and asc on request, within the batch', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const files: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        files.push(await seedFile(OWNER, `o${i}.txt`));
      }
      const created = await createBatchViaHttp(store.id, { file_ids: files });
      await spaceOutCreatedAt(store.id, files);

      const desc = await listBatchFilesViaHttp(store.id, created.body.id);
      const asc = await listBatchFilesViaHttp(store.id, created.body.id, { order: 'asc' });

      expect(desc.body.data.map((f: any) => f.id)).toEqual([...files].reverse());
      expect(asc.body.data.map((f: any) => f.id)).toEqual(files);
    });

    it('walks backwards with before and returns the page in display order', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const files: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        files.push(await seedFile(OWNER, `b${i}.txt`));
      }
      const created = await createBatchViaHttp(store.id, { file_ids: files });
      await spaceOutCreatedAt(store.id, files);
      const expected = [...files].reverse(); // [f4, f3, f2, f1, f0]

      // The two entries immediately BEFORE expected[3] in display order.
      const res = await listBatchFilesViaHttp(store.id, created.body.id, { limit: 2, before: expected[3] });

      // Reversed back into display order: an unreversed page would return
      // [expected[1], expected[2]], whose last_id fed back as `after` re-serves
      // the page just read.
      expect(res.body.data.map((f: any) => f.id)).toEqual([expected[1], expected[2]]);
      expect(res.body.first_id).toBe(expected[1]);
      expect(res.body.last_id).toBe(expected[2]);
      expect(res.body.has_more).toBe(true);
    });

    it('lets after win when a caller supplies both after and before', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const files: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        files.push(await seedFile(OWNER, `w${i}.txt`));
      }
      const created = await createBatchViaHttp(store.id, { file_ids: files });
      await spaceOutCreatedAt(store.id, files);
      const expected = [...files].reverse();

      const res = await listBatchFilesViaHttp(store.id, created.body.id, {
        limit: 2, after: expected[0], before: expected[3],
      });

      // Deliberate, documented rule (not a 400), and the same one the
      // store-level list applies: `after ?? before`. Had `before` won, the page
      // would have been the two entries preceding expected[3].
      expect(res.body.data.map((f: any) => f.id)).toEqual([expected[1], expected[2]]);
    });

    it('filters by status within the batch', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const fileA = await seedFile(OWNER, 'a.txt');
      const fileB = await seedFile(OWNER, 'b.txt');
      const created = await createBatchViaHttp(store.id, { file_ids: [fileA, fileB] });
      await pool.query(
        "UPDATE vector_store_files SET status = 'completed' WHERE store_id = $1 AND file_id = $2", [store.id, fileA],
      );

      const completed = await listBatchFilesViaHttp(store.id, created.body.id, { filter: 'completed' });
      const running = await listBatchFilesViaHttp(store.id, created.body.id, { filter: 'in_progress' });

      expect(completed.body.data.map((f: any) => f.id)).toEqual([fileA]);
      expect(running.body.data.map((f: any) => f.id)).toEqual([fileB]);
    });

    it('400s an unknown filter value rather than silently listing everything', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const fileA = await seedFile(OWNER, 'a.txt');
      const created = await createBatchViaHttp(store.id, { file_ids: [fileA] });

      const res = await listBatchFilesViaHttp(store.id, created.body.id, { filter: 'bogus' });
      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('invalid_filter');
    });

    it('returns an empty page for a cursor that belongs to a different batch', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const mine = await seedFile(OWNER, 'mine.txt');
      const theirs = await seedFile(OWNER, 'sibling.txt');
      const first = await createBatchViaHttp(store.id, { file_ids: [mine] });
      const second = await createBatchViaHttp(store.id, { file_ids: [theirs] });
      expect(second.statusCode).toBe(200);

      // The cursor is resolved WITHIN the batch, so a sibling's file id is as
      // good as no cursor — and "as good as no cursor" must not mean "ignore
      // the cursor and serve page one".
      const res = await listBatchFilesViaHttp(store.id, first.body.id, { after: theirs });

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        object: 'list', data: [], has_more: false, first_id: null, last_id: null,
      });
    });

    it('returns an empty list for a real batch that has no files', async () => {
      // The counterpart to the 404 below: an empty batch is a real resource
      // whose file list is legitimately empty, which is exactly the response a
      // missing existence check would fabricate for a batch that never existed.
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
      const empty = await createBatch(store.id, [], null, null);

      const res = await listBatchFilesViaHttp(store.id, empty.id);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        object: 'list', data: [], has_more: false, first_id: null, last_id: null,
      });
    });

    it('404s the file list for a batch id that does not exist rather than returning an empty list', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });

      const res = await listBatchFilesViaHttp(store.id, newBatchId());
      expect(res.statusCode).toBe(404);
      expect(res.body.error.type).toBe('invalid_request_error');
      expect(res.body.error.code).toBe('vector_store_file_batch_not_found');
    });

    it('404s the file list for a batch from another store rather than leaking its members', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER, name: 'mine' });
      const otherStore = await repo.createStore({ ownerEmail: OWNER, name: 'also mine' });
      const fileA = await seedFile(OWNER, 'a.txt');
      const created = await createBatchViaHttp(store.id, { file_ids: [fileA] });

      const res = await listBatchFilesViaHttp(otherStore.id, created.body.id);
      expect(res.statusCode).toBe(404);
      expect(res.body.error.code).toBe('vector_store_file_batch_not_found');
    });

    it('404s the file list of a real batch in a store owned by another caller, and never 403', async () => {
      const theirStore = await repo.createStore({ ownerEmail: OTHER, name: 'theirs' });
      const theirFile = await seedFile(OTHER, 'theirs.txt');
      const created = await createBatchViaHttp(theirStore.id, { file_ids: [theirFile] }, OTHER);
      expect(created.statusCode).toBe(200);

      const res = await listBatchFilesViaHttp(theirStore.id, created.body.id, {}, OWNER);
      expect(res.statusCode).toBe(404);
      expect(res.statusCode).not.toBe(403);
      expect(res.body.error.code).toBe('vector_store_not_found');
    });

    it('401s a file list with no caller identity, before any query runs', async () => {
      const res = makeRes();
      await ctrl.listVectorStoreFileBatchFiles(
        { headers: {}, params: { id: 'vs_x', batch_id: 'vsfb_x' }, query: {}, body: {} } as any,
        res,
        throwOnError,
      );
      expect(res.statusCode).toBe(401);
    });
  });
});

// ---------------------------------------------------------------------------
// Route registration — no database needed
// ---------------------------------------------------------------------------

/**
 * `test/nul-byte-guard-routers.test.ts` drives every (router, param) pair it
 * knows about through a real Express dispatch, but its case table predates
 * `:batch_id`. This asserts the registration itself, on the real router
 * module: `router.param` stores its callbacks in `router.params[name]`
 * (express 4), so a route added with an unguarded `:batch_id` — where a NUL
 * reaches Postgres as raw text and throws 22021 as an unhandled 500 — fails
 * here.
 */
describe('vectorStoresRoutes — NUL-byte guard registration', () => {
  it('guards :batch_id with the same param guard as :id and :file_id', () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const router = require('../../../src/routes/vectorStoresRoutes').default;
    const { nulByteParamGuard } = require('../../../src/middlewares/nulByteGuard');
    /* eslint-enable @typescript-eslint/no-var-requires */

    expect(router.params.id).toContain(nulByteParamGuard);
    expect(router.params.file_id).toContain(nulByteParamGuard);
    expect(router.params.batch_id).toContain(nulByteParamGuard);
  });

  it('mounts all four file-batch routes', () => {
    /* eslint-disable-next-line @typescript-eslint/no-var-requires */
    const router = require('../../../src/routes/vectorStoresRoutes').default;
    const mounted = router.stack
      .filter((layer: any) => layer.route)
      .map((layer: any) => `${Object.keys(layer.route.methods)[0]} ${layer.route.path}`);

    expect(mounted).toContain('post /:id/file_batches');
    expect(mounted).toContain('get /:id/file_batches/:batch_id');
    expect(mounted).toContain('post /:id/file_batches/:batch_id/cancel');
    expect(mounted).toContain('get /:id/file_batches/:batch_id/files');
  });

  it('does not let the retrieve route swallow the cancel and files paths', () => {
    /* eslint-disable-next-line @typescript-eslint/no-var-requires */
    const router = require('../../../src/routes/vectorStoresRoutes').default;
    const layerFor = (path: string) => router.stack.find((l: any) => l.route && l.route.path === path);

    // `:batch_id` must not be allowed to swallow a `/`, or
    // `get /:id/file_batches/:batch_id` — registered first — would match
    // `.../vsfb_1/files` with batch_id = 'vsfb_1/files' and the file list would
    // be unreachable while still appearing in the route table above.
    const retrieve = layerFor('/:id/file_batches/:batch_id');
    expect(retrieve.regexp.test('/vs_1/file_batches/vsfb_1/files')).toBe(false);
    expect(retrieve.regexp.test('/vs_1/file_batches/vsfb_1/cancel')).toBe(false);
    expect(retrieve.regexp.test('/vs_1/file_batches/vsfb_1')).toBe(true);
  });
});
